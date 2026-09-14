import {
  AgentDefinitionError,
  AgentId,
  CommandId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationAgent,
  type OrchestrationCommand,
  type OrchestrationListAgentDefinitionsResult,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectId,
} from "@iskra/contracts";
import {
  AGENT_DEFINITIONS_DIR,
  DEFAULT_CLAUDE_AGENT_MODEL,
  IMPORTABLE_AGENT_SOURCES,
  importAgentFile,
  parseAgentFile,
  serializeAgentFile,
  withAgentId,
  type AgentDefinition,
  type AgentFileResult,
} from "@iskra/shared/agentDefinitions";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeModelSlug,
} from "../provider/ClaudeModelCatalog.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export interface AgentImportResult {
  readonly imported: ReadonlyArray<{ readonly agentId: AgentId; readonly name: string }>;
  readonly skipped: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

/**
 * Keeps a project's agents in step with its `.iskra/agents/*.md` files. The
 * files are the definitions; the event log records each change and holds what
 * a file cannot (presence, history). A file without an `id` gets one written
 * into it, taking over an agent of the same name that no file defines, so
 * re-adding a deleted agent restores it. An agent whose file is gone is
 * archived. A project that has agents but no folder yet has them written out.
 */
export class AgentDefinitionSync extends Context.Service<
  AgentDefinitionSync,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly reconcile: (projectId: ProjectId) => Effect.Effect<void, AgentDefinitionError>;
    readonly save: (input: {
      readonly projectId: ProjectId;
      readonly definition: AgentDefinition;
    }) => Effect.Effect<{ readonly agentId: AgentId }, AgentDefinitionError>;
    /** A project's agents as definitions, archived ones included. */
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<OrchestrationListAgentDefinitionsResult, AgentDefinitionError>;
    /** Archives an agent by deleting its file; saving its definition again unarchives it. */
    readonly archive: (input: {
      readonly projectId: ProjectId;
      readonly agentId: AgentId;
    }) => Effect.Effect<void, AgentDefinitionError>;
    readonly importDefinitions: (
      projectId: ProjectId,
    ) => Effect.Effect<AgentImportResult, AgentDefinitionError>;
  }
>()("@iskra/cli/orchestration/AgentDefinitionSync") {}

const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

/**
 * Imported agents run on Claude. A Claude alias or slug the catalog knows is
 * kept; `inherit`, nothing, or another vendor's model gets the default.
 */
export function resolveImportedModel(model: string | null): ModelSelection {
  const slug = model === null ? null : resolveClaudeModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, model);
  const known =
    slug !== null && BUNDLED_CLAUDE_MODEL_CATALOG.models.some((entry) => entry.model.slug === slug);
  return {
    instanceId: CLAUDE_INSTANCE,
    model: known && slug !== null ? slug : DEFAULT_CLAUDE_AGENT_MODEL,
  };
}

const definitionOfAgent = (agent: OrchestrationAgent): AgentDefinition => ({
  id: agent.id,
  name: agent.name,
  avatar: agent.avatar,
  tags: agent.roleTags,
  modelSelection: agent.modelSelection,
  capabilities: agent.capabilities,
  rolePrompt: agent.rolePrompt,
});

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );

interface AgentFile {
  readonly filePath: string;
  readonly contents: string;
  readonly result: AgentFileResult;
}

const definedId = (file: AgentFile): AgentId | null =>
  file.result.ok ? file.result.definition.id : null;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // One pass at a time: the poll, a save and an import never interleave writes.
  const semaphore = yield* Semaphore.make(1);
  // The last problem logged per file or project, so a bad file is reported once, not every poll.
  const reported = new Map<string, string>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:agent-files:${tag}:${uuid}`)),
    );
  const newAgentId = crypto.randomUUIDv4.pipe(Effect.map(AgentId.make));
  const toError = (message: string) => (cause: unknown) =>
    new AgentDefinitionError({ message, cause });
  const isDefinitionError = Schema.is(AgentDefinitionError);
  const asDefinitionError = (message: string) => (error: unknown) =>
    isDefinitionError(error) ? error : toError(message)(error);

  const report = (key: string, message: string) =>
    reported.get(key) === message
      ? Effect.void
      : Effect.sync(() => reported.set(key, message)).pipe(
          Effect.andThen(Effect.logWarning(message)),
        );
  const reportFailure = (key: string, message: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : report(key, `${message}: ${Cause.pretty(cause)}`);

  const readModel = snapshotQuery
    .getCommandReadModel()
    .pipe(Effect.mapError(toError("Could not read the server's agents and projects.")));
  const findProject = (model: OrchestrationReadModel, projectId: ProjectId) => {
    const project = model.projects.find(
      (candidate) => candidate.id === projectId && candidate.deletedAt === null,
    );
    return project === undefined
      ? Effect.fail(new AgentDefinitionError({ message: "The project no longer exists." }))
      : Effect.succeed(project);
  };
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);
  const agentsDir = (project: OrchestrationProject) =>
    path.join(project.workspaceRoot, AGENT_DEFINITIONS_DIR);

  const readAgentFiles = (dir: string) =>
    Effect.gen(function* () {
      const names = (yield* fileSystem.readDirectory(dir))
        .filter((name) => name.endsWith(".md"))
        .toSorted();
      return yield* Effect.forEach(names, (name) => {
        const filePath = path.join(dir, name);
        return fileSystem.readFileString(filePath).pipe(
          Effect.map((contents): AgentFile => ({
            filePath,
            contents,
            result: parseAgentFile(contents, name),
          })),
        );
      });
    });

  const applyDefinition = (
    project: OrchestrationProject,
    agentId: AgentId,
    definition: AgentDefinition,
    existing: OrchestrationAgent | undefined,
  ) =>
    Effect.gen(function* () {
      if (existing === undefined) {
        yield* dispatch({
          type: "agent.create",
          commandId: yield* commandId("create"),
          agentId,
          projectId: project.id,
          name: definition.name,
          ...(definition.avatar !== null ? { avatar: definition.avatar } : {}),
          roleTags: [...definition.tags],
          rolePrompt: definition.rolePrompt,
          modelSelection: definition.modelSelection,
          capabilities: [...definition.capabilities],
          createdAt: yield* nowIso,
        });
        return;
      }
      if (existing.archivedAt !== null) {
        yield* dispatch({
          type: "agent.unarchive",
          commandId: yield* commandId("unarchive"),
          agentId,
        });
      }
      const changes = {
        ...(existing.name !== definition.name ? { name: definition.name } : {}),
        ...(existing.avatar !== definition.avatar ? { avatar: definition.avatar } : {}),
        ...(canonical(existing.roleTags) !== canonical(definition.tags)
          ? { roleTags: [...definition.tags] }
          : {}),
        ...(existing.rolePrompt !== definition.rolePrompt
          ? { rolePrompt: definition.rolePrompt }
          : {}),
        ...(canonical(existing.modelSelection) !== canonical(definition.modelSelection)
          ? { modelSelection: definition.modelSelection }
          : {}),
        ...(canonical(existing.capabilities) !== canonical(definition.capabilities)
          ? { capabilities: [...definition.capabilities] }
          : {}),
      };
      if (Object.keys(changes).length > 0) {
        yield* dispatch({
          type: "agent.update",
          commandId: yield* commandId("update"),
          agentId,
          ...changes,
        });
      }
    });

  const reconcileProject = (project: OrchestrationProject, model: OrchestrationReadModel) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(project.workspaceRoot))) {
        return;
      }
      const dir = agentsDir(project);
      const allAgents = model.agents ?? [];
      const projectAgents = allAgents.filter((agent) => agent.projectId === project.id);

      if (!(yield* fileSystem.exists(dir))) {
        // A project from before agent files: write its agents out. Deleting the
        // whole folder does the same, so archive agents by deleting their files.
        const active = projectAgents.filter((agent) => agent.archivedAt === null);
        if (active.length === 0) {
          return;
        }
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        for (const agent of active) {
          yield* fileSystem.writeFileString(
            path.join(dir, `${agent.name}.md`),
            serializeAgentFile(definitionOfAgent(agent)),
          );
        }
        return;
      }

      const files = yield* readAgentFiles(dir);
      const claimedIds = new Set(files.flatMap((file) => definedId(file) ?? []));
      const seen = new Set<AgentId>();
      // Archive only when every file was understood; a broken file may define an agent.
      let complete = true;

      for (const file of files) {
        if (!file.result.ok) {
          complete = false;
          yield* report(
            file.filePath,
            `Agent file ${file.filePath} is invalid: ${file.result.error}`,
          );
          continue;
        }
        const definition = file.result.definition;
        let agentId = definition.id;
        if (agentId === null) {
          agentId =
            projectAgents.find(
              (agent) => agent.name === definition.name && !claimedIds.has(agent.id),
            )?.id ?? (yield* newAgentId);
          claimedIds.add(agentId);
          yield* fileSystem.writeFileString(file.filePath, withAgentId(file.contents, agentId));
        }
        if (seen.has(agentId)) {
          complete = false;
          yield* report(file.filePath, `Agent file ${file.filePath} repeats another file's id.`);
          continue;
        }
        seen.add(agentId);
        const existing = allAgents.find((agent) => agent.id === agentId);
        if (existing !== undefined && existing.projectId !== project.id) {
          complete = false;
          yield* report(
            file.filePath,
            `Agent file ${file.filePath} uses another project's agent id.`,
          );
          continue;
        }
        const applied = yield* applyDefinition(project, agentId, definition, existing).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            reportFailure(
              file.filePath,
              `Agent file ${file.filePath} was not applied`,
            )(cause).pipe(Effect.as(false)),
          ),
        );
        if (applied) {
          reported.delete(file.filePath);
        }
      }

      if (!complete) {
        return;
      }
      for (const agent of projectAgents) {
        if (agent.archivedAt === null && !seen.has(agent.id)) {
          yield* dispatch({
            type: "agent.archive",
            commandId: yield* commandId("archive"),
            agentId: agent.id,
          });
        }
      }
    });

  const reconcile = (projectId: ProjectId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const model = yield* readModel;
        const project = yield* findProject(model, projectId);
        yield* reconcileProject(project, model).pipe(
          Effect.mapError(toError(`Could not sync the agent files of ${project.title}.`)),
        );
      }),
    );

  const reconcileAll = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const model = yield* readModel;
      for (const project of model.projects) {
        if (project.deletedAt === null) {
          yield* reconcileProject(project, model).pipe(
            Effect.catchCause(
              reportFailure(project.id, `Could not sync the agent files of ${project.title}`),
            ),
          );
        }
      }
    }),
  );

  const save: AgentDefinitionSync["Service"]["save"] = ({ projectId, definition }) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const model = yield* readModel;
        const project = yield* findProject(model, projectId);
        // Write out a project's existing agents first, so creating the folder archives nothing.
        yield* reconcileProject(project, model);
        const dir = agentsDir(project);
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        const files = yield* readAgentFiles(dir);
        const target = path.join(dir, `${definition.name}.md`);
        const projectAgents = ((yield* readModel).agents ?? []).filter(
          (agent) => agent.projectId === project.id,
        );
        // Names are unique among a project's agents, archived ones included: unarchive instead.
        const taken = projectAgents.find(
          (agent) => agent.name === definition.name && agent.id !== definition.id,
        );
        if (taken !== undefined) {
          return yield* new AgentDefinitionError({
            message: `An agent named ${definition.name} already exists in this project${taken.archivedAt !== null ? " (archived)" : ""}.`,
          });
        }
        const agentId = definition.id ?? (yield* newAgentId);
        if (files.some((file) => file.filePath === target && definedId(file) !== agentId)) {
          return yield* new AgentDefinitionError({
            message: `Another agent is already defined in ${AGENT_DEFINITIONS_DIR}/${definition.name}.md.`,
          });
        }
        yield* fileSystem.writeFileString(
          target,
          serializeAgentFile({ ...definition, id: agentId }),
        );
        // A rename leaves the old file behind; remove it so the agent is defined once.
        for (const file of files) {
          if (file.filePath !== target && definedId(file) === agentId) {
            yield* fileSystem.remove(file.filePath);
          }
        }
        yield* reconcileProject(project, yield* readModel);
        const saved = ((yield* readModel).agents ?? []).some(
          (agent) =>
            agent.id === agentId && agent.archivedAt === null && agent.name === definition.name,
        );
        if (!saved) {
          return yield* new AgentDefinitionError({
            message: reported.get(target) ?? `${definition.name} could not be saved.`,
          });
        }
        return { agentId };
      }).pipe(Effect.mapError(asDefinitionError(`Could not save ${definition.name}.`))),
    );

  const list: AgentDefinitionSync["Service"]["list"] = (projectId) =>
    Effect.gen(function* () {
      const model = yield* readModel;
      yield* findProject(model, projectId);
      return {
        agents: (model.agents ?? [])
          .filter((agent) => agent.projectId === projectId)
          .map((agent) => ({
            definition: { ...definitionOfAgent(agent), id: agent.id },
            archived: agent.archivedAt !== null,
          })),
      };
    });

  const archive: AgentDefinitionSync["Service"]["archive"] = ({ projectId, agentId }) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const model = yield* readModel;
        const project = yield* findProject(model, projectId);
        // Write out a project's agents first, so there is a file to delete.
        yield* reconcileProject(project, model);
        const agent = ((yield* readModel).agents ?? []).find(
          (candidate) => candidate.id === agentId && candidate.projectId === project.id,
        );
        if (agent === undefined) {
          return yield* new AgentDefinitionError({ message: "That agent no longer exists." });
        }
        if (agent.archivedAt !== null) {
          return yield* new AgentDefinitionError({ message: "That agent is already archived." });
        }
        for (const file of yield* readAgentFiles(agentsDir(project))) {
          if (definedId(file) === agentId) {
            yield* fileSystem.remove(file.filePath);
          }
        }
        yield* reconcileProject(project, yield* readModel);
        const archived = ((yield* readModel).agents ?? []).some(
          (candidate) => candidate.id === agentId && candidate.archivedAt !== null,
        );
        if (!archived) {
          return yield* new AgentDefinitionError({
            message: `@${agent.name} was not archived: fix the invalid files in ${AGENT_DEFINITIONS_DIR} first.`,
          });
        }
      }).pipe(Effect.mapError(asDefinitionError("Could not archive the agent."))),
    );

  const importDefinitions: AgentDefinitionSync["Service"]["importDefinitions"] = (projectId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const model = yield* readModel;
        const project = yield* findProject(model, projectId);
        yield* reconcileProject(project, model);
        const dir = agentsDir(project);
        const takenNames = new Set(
          ((yield* readModel).agents ?? [])
            .filter((agent) => agent.projectId === project.id && agent.archivedAt === null)
            .map((agent) => agent.name as string),
        );
        if (yield* fileSystem.exists(dir)) {
          for (const file of yield* readAgentFiles(dir)) {
            if (file.result.ok) {
              takenNames.add(file.result.definition.name);
            }
          }
        }
        const imported: Array<string> = [];
        const skipped: Array<{ file: string; reason: string }> = [];
        for (const source of IMPORTABLE_AGENT_SOURCES) {
          const sourceDir = path.join(project.workspaceRoot, source.dir);
          if (!(yield* fileSystem.exists(sourceDir))) {
            continue;
          }
          const names = (yield* fileSystem.readDirectory(sourceDir))
            .filter((name) => name.endsWith(".md"))
            .toSorted();
          for (const name of names) {
            const file = `${source.dir}/${name}`;
            const result = importAgentFile(
              yield* fileSystem.readFileString(path.join(sourceDir, name)),
              file,
              resolveImportedModel,
            );
            if (!result.ok) {
              skipped.push({ file, reason: result.error });
              continue;
            }
            if (takenNames.has(result.definition.name)) {
              skipped.push({
                file,
                reason: `An agent named ${result.definition.name} already exists.`,
              });
              continue;
            }
            yield* fileSystem.makeDirectory(dir, { recursive: true });
            yield* fileSystem.writeFileString(
              path.join(dir, `${result.definition.name}.md`),
              serializeAgentFile(result.definition),
            );
            takenNames.add(result.definition.name);
            imported.push(result.definition.name);
          }
        }
        if (imported.length > 0) {
          yield* reconcileProject(project, yield* readModel);
        }
        const agents = (yield* readModel).agents ?? [];
        return {
          imported: imported.flatMap((name) => {
            const agent = agents.find(
              (candidate) =>
                candidate.projectId === project.id &&
                candidate.name === name &&
                candidate.archivedAt === null,
            );
            return agent === undefined ? [] : [{ agentId: agent.id, name }];
          }),
          skipped,
        };
      }).pipe(Effect.mapError(asDefinitionError("Could not import agent definitions."))),
    );

  const start = Effect.fn("AgentDefinitionSync.start")(function* () {
    // ponytail: polls every project's agents folder every 2s; watch the folders if projects get many.
    yield* forkParked(reconcileAll.pipe(Effect.repeat(Schedule.spaced("2 seconds"))));
  });

  return {
    start,
    reconcile,
    save,
    list,
    archive,
    importDefinitions,
  } satisfies AgentDefinitionSync["Service"];
});

export const layer = Layer.effect(AgentDefinitionSync, make);
