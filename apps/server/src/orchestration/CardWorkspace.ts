// @effect-diagnostics nodeBuiltinImport:off - Effect's Path has no glob matching.
import * as NodePath from "node:path";

import {
  PROJECT_SECRET_NAME_PATTERN,
  CARD_PORT_BLOCK_SIZE,
  CommandId,
  projectOrchestrationOf,
  type CardId,
  type OrchestrationCard,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectId,
  type ProjectOrchestration,
  type ProjectScript,
  type ServerSettings,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import { HostProcessPlatform } from "@iskra/shared/hostProcess";
import * as Net from "@iskra/shared/Net";
import {
  archiveProjectScript,
  cardScriptEnv,
  cardSlug,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@iskra/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { stripTerminalControl } from "../project/ProjectSetupScriptRunner.ts";
import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { CardRefGuard } from "./CardRefGuard.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import { HostAdmission } from "./HostAdmission.ts";
import {
  projectChecks,
  readProjectFile,
  type ProjectCheck,
  type ProjectFileConfig,
  type ProjectServiceConfig,
} from "./ProjectFile.ts";
import { hostResourceEnv } from "./ResourceEnv.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export class CardWorkspaceError extends Schema.TaggedError<CardWorkspaceError>()(
  "CardWorkspaceError",
  {
    cardId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * A server-run checks request. "full" runs each check's command; "targeted" runs its
 * targetedCommand with `{filter}` replaced by the shell-quoted filter (checks without one run their
 * full command). `checks` defaults to the card's project file checks; source "ci" checks are
 * skipped here. Heavy and not admission-controlled itself: call it inside HostAdmission.run.
 */
export interface RunChecksInput {
  readonly cardId: CardId;
  readonly scope: "targeted" | "full";
  readonly filter?: string | undefined;
  readonly checks?: ReadonlyArray<ProjectCheck> | undefined;
}

/**
 * A journeys request: the project file's journeys, in order, stopping at the first failure, each
 * with its own timeout and the ISKRA_PORT_* env of where it runs. Services are brought up (and
 * waited on) first. `snapshot` runs them there; otherwise in the card's worktree. With no journeys
 * declared nothing runs and the run passes: journeys are required only once declared. Heavy: call it
 * inside HostAdmission.run with kind "journey".
 */
export interface RunJourneysInput {
  readonly cardId: CardId;
  readonly snapshot?: Pick<CardSnapshot, "path" | "portBase" | "ensureServices"> | undefined;
}

/** A service or the card's preview, and whether its port has a listener right now. */
export interface CardServiceHealth {
  readonly kind: "service" | "preview";
  // The service's name, or the run script's id for the preview.
  readonly name: string;
  readonly port: number;
  readonly up: boolean;
}

/** One check's outcome. `logTail` (≤2k, secrets scrubbed) is the only part agents see. */
export interface CardCheckResult {
  readonly id: string;
  readonly name: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly logTail: string;
  // Absolute path of the full log (≤1MB) under the card's attachments; null if it wasn't saved.
  readonly logArtifactPath: string | null;
}

/**
 * Checks run in order and stop at the first failure, so `results` may be shorter than the
 * request. `passed` is false when nothing ran: whether no checks may pass is the caller's policy.
 */
export interface CardChecksRun {
  readonly passed: boolean;
  readonly summary: string;
  readonly results: ReadonlyArray<CardCheckResult>;
}

/** Where landing a card ended: merged into its base, or stopped with why. */
export type CardLandResult =
  | { readonly kind: "landed"; readonly baseBranch: string; readonly files: ReadonlyArray<string> }
  | { readonly kind: "conflict"; readonly baseBranch: string; readonly files: ReadonlyArray<string> }
  | {
      readonly kind: "checksFailed";
      readonly summary: string;
      readonly results: ReadonlyArray<CardCheckResult>;
    }
  | { readonly kind: "notMerged"; readonly message: string };

export interface CardWorkspaceInfo {
  readonly branch: string;
  readonly worktreePath: string;
  readonly portBase: number;
}

/**
 * A detached checkout of one commit of a card, with its own port block and services, for work
 * that must not touch the builder's worktree (the verifier). Setup and services run without
 * secrets. `ensureServices` restarts any service that stopped answering; `release` runs archive,
 * stops the services and removes the checkout, and is safe to call twice.
 */
export interface CardSnapshot {
  readonly path: string;
  readonly portBase: number;
  // Each project file port by name, inside this snapshot's block.
  readonly ports: Readonly<Record<string, number>>;
  readonly ensureServices: Effect.Effect<void, CardWorkspaceError>;
  readonly release: Effect.Effect<void>;
}

/** The card's base, the ref it resolves to on this machine, and the project file read there. */
export interface CardProjectFile {
  readonly baseBranch: string;
  // origin/<base> when origin's copy is at least as new as the local branch, else <base>.
  readonly baseRef: string;
  readonly file: ProjectFileConfig | null;
  readonly checks: ReadonlyArray<ProjectCheck>;
}

/**
 * A card's workspace: its own git worktree and branch, and a block of ports its scripts receive.
 * `ensure` creates it when work starts (fetch the base, add the worktree, render env files, run
 * setup, start services), removing it again if any step fails. When a card lands or is abandoned
 * the workspace is torn down: the archive script runs, the card's terminals close (stopping its
 * services), and the worktree and branch go. `land` commits, rebases, checks and fast-forwards
 * the base for local landing (invariant 7).
 */
export class CardWorkspace extends Context.Service<
  CardWorkspace,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly ensure: (cardId: CardId) => Effect.Effect<CardWorkspaceInfo, CardWorkspaceError>;
    /** A detached checkout of `headSha` on its own ports with services up; see CardSnapshot. */
    readonly snapshot: (
      cardId: CardId,
      headSha: string,
    ) => Effect.Effect<CardSnapshot, CardWorkspaceError>;
    /**
     * Starts each of the card's services that isn't answering its ready probe and waits until all
     * are ready. Idempotent: services already up are left alone, and services a server restart
     * lost come back.
     */
    readonly ensureServices: (cardId: CardId) => Effect.Effect<void, CardWorkspaceError>;
    /** The card's changes against its base, untracked files included; empty before it has a worktree. */
    readonly diff: (
      cardId: CardId,
    ) => Effect.Effect<{ readonly baseBranch: string; readonly diff: string }, CardWorkspaceError>;
    readonly runChecks: (input: RunChecksInput) => Effect.Effect<CardChecksRun, CardWorkspaceError>;
    readonly runJourneys: (
      input: RunJourneysInput,
    ) => Effect.Effect<CardChecksRun, CardWorkspaceError>;
    /**
     * The card's services, and its preview once a run script started it in this process, with
     * whether each port listens now. Empty for a card without a worktree.
     */
    readonly serviceHealth: (
      cardId: CardId,
    ) => Effect.Effect<ReadonlyArray<CardServiceHealth>, CardWorkspaceError>;
    /** Files the card changes against its base: committed, uncommitted and untracked. */
    readonly changedFiles: (
      cardId: CardId,
    ) => Effect.Effect<ReadonlyArray<string>, CardWorkspaceError>;
    /**
     * Lands the card locally: commits what its agent left uncommitted, rebases onto the base,
     * runs the checks (admission-controlled) and fast-forwards the base. A conflict aborts the
     * rebase. Cards touching the same exclusive path land one at a time.
     */
    readonly land: (cardId: CardId) => Effect.Effect<CardLandResult, CardWorkspaceError>;
    /** Runs `effect` under the card's lock, so its ensure, land and teardown can't run meanwhile. */
    readonly withCardLock: <A, E, R>(
      cardId: CardId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly runScript: (input: {
      readonly cardId: CardId;
      readonly scriptId: string;
    }) => Effect.Effect<{ readonly terminalId: string }, CardWorkspaceError>;
    readonly projectFile: (cardId: CardId) => Effect.Effect<CardProjectFile, CardWorkspaceError>;
    /** Every open card in the project with a worktree, and the files it changes. */
    readonly openCardChangedFiles: (
      projectId: ProjectId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly cardId: CardId; readonly files: ReadonlyArray<string> }>,
      CardWorkspaceError
    >;
  }
>()("@iskra/cli/orchestration/CardWorkspace") {}

/** The first port handed to a card; blocks of CARD_PORT_BLOCK_SIZE go up from here. */
const CARD_PORT_RANGE_START = 42_000;
const CARD_PORT_BLOCK_LIMIT = 500;
const SCRIPT_TIMEOUT = "10 minutes";
const SCRIPT_OUTPUT_TAIL = 2_000;
const CHECK_LOG_MAX_BYTES = 1_048_576;

/** A card's script terminals live under this terminal thread id. */
export const cardTerminalThreadId = (cardId: CardId): string => `card:${cardId}`;

/** `iskra/<title>-<id suffix>`: readable in `git branch`, unique per card. */
export const cardBranchName = (card: Pick<OrchestrationCard, "id" | "title">): string => {
  const slug =
    card.title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40) || "card";
  const suffix =
    card.id
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, "")
      .slice(-6) || "card";
  return `iskra/${slug}-${suffix}`;
};

/**
 * The branch a card starts from and lands into: its own base, else its parent's branch (a plan's
 * integration branch, or a builder's branch for its sub-cards), else the project's policy. Null
 * means the repository's default branch.
 */
export const baseBranchOf = (
  card: Pick<OrchestrationCard, "baseBranch" | "parentCardId" | "projectId">,
  model: Pick<OrchestrationReadModel, "cards" | "projects">,
): string | null => {
  const parentBranch =
    card.parentCardId === null
      ? null
      : ((model.cards ?? []).find((candidate) => candidate.id === card.parentCardId)?.branch ??
        null);
  const project = model.projects.find((candidate) => candidate.id === card.projectId);
  return (
    card.baseBranch ??
    parentBranch ??
    (project === undefined ? null : projectOrchestrationOf(project).baseBranch)
  );
};

/** The exclusive paths a set of changed files touches. */
export const exclusivePathConflicts = (
  changedFiles: ReadonlyArray<string>,
  policy: Pick<ProjectOrchestration, "exclusivePaths">,
): ProjectOrchestration["exclusivePaths"] =>
  policy.exclusivePaths.filter((entry) =>
    changedFiles.some((file) => NodePath.posix.matchesGlob(file, entry.glob)),
  );

/**
 * Whether an estimate's likely area (a path or glob) can touch files an exclusive-path glob covers:
 * it matches the glob, or either one's fixed leading part contains the other's.
 * ponytail: prefix overlap, so `packages/core/d` counts as touching `packages/core/db/**`.
 */
export const areaOverlapsGlob = (area: string, glob: string): boolean => {
  const path = area.replace(/^\.?\//, "");
  const fixed = (pattern: string) => pattern.split(/[*?[{]/)[0] ?? "";
  return (
    NodePath.posix.matchesGlob(path, glob) ||
    fixed(path).startsWith(fixed(glob)) ||
    fixed(glob).startsWith(fixed(path))
  );
};

/** What an open card is told when another card landed changes to an exclusive path it touches. */
export const exclusivePathReturnMessage = (input: {
  readonly glob: string;
  readonly baseRef: string;
  readonly afterRebase: string | null;
}): string =>
  `Another card changed ${input.glob}. Rebase onto ${input.baseRef}${
    input.afterRebase === null ? "" : `, then run \`${input.afterRebase}\``
  } before asking for review.`;

/** A project secret as a card's setup sees it; `value` is null when this machine has none. */
export interface CardSecret {
  readonly name: string;
  readonly exposure: "setup" | "workspace";
  readonly value: string | null;
}

/** Where a project's card secret value lives in the server secret store. */
export const cardSecretStoreName = (projectId: ProjectId, name: string): string =>
  `card-secret-${projectId}-${name}`;

/**
 * Fills `${port:NAME}`, `${card:slug}`, `${card:id}` and `${secret:NAME}`. Only "workspace"
 * secrets may be written: the agent reads the worktree.
 */
export const renderEnvTemplate = (
  template: string,
  context: {
    readonly cardId: string;
    readonly ports: Readonly<Record<string, number>>;
    readonly secrets: ReadonlyArray<CardSecret>;
  },
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } => {
  const problems: Array<string> = [];
  const text = template.replaceAll(
    /\$\{(port|card|secret):([A-Za-z0-9_]+)\}/g,
    (placeholder, kind: string, name: string) => {
      if (kind === "port") {
        const port = context.ports[name];
        if (port === undefined) problems.push(`Port ${name} isn't in the project file's ports.`);
        return port === undefined ? placeholder : String(port);
      }
      if (kind === "card") {
        if (name === "slug") return cardSlug(context.cardId);
        if (name === "id") return context.cardId;
        problems.push(`Unknown placeholder ${placeholder}.`);
        return placeholder;
      }
      const secret = context.secrets.find((candidate) => candidate.name === name);
      if (secret === undefined) {
        problems.push(`Secret ${name} isn't configured for this project.`);
      } else if (secret.exposure === "setup") {
        problems.push(`Secret ${name} is setup-only and can't be written into the worktree.`);
      } else if (secret.value === null) {
        problems.push(`Secret ${name} has no value on this machine.`);
      } else {
        return secret.value;
      }
      return placeholder;
    },
  );
  return problems.length === 0 ? { ok: true, text } : { ok: false, message: problems.join(" ") };
};

const scrubSecrets = (text: string, secrets: ReadonlyArray<CardSecret>) =>
  secrets.reduce(
    (scrubbed, secret) =>
      secret.value !== null && secret.value.length >= 4
        ? scrubbed.replaceAll(secret.value, "[secret]")
        : scrubbed,
    text,
  );

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner;
  const net = yield* Net.NetService;
  const terminals = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const secretStore = yield* ServerSecretStore;
  const admission = yield* HostAdmission;
  const refGuard = yield* CardRefGuard;

  // Per-card locks serialize one card's ensure, land and teardown; per-project locks guard only
  // port allocation, worktree add and the local fast-forward; per-glob locks serialize landings
  // that touch one exclusive path.
  // ponytail: locks are never dropped, one semaphore per card/project/glob ever seen; prune at teardown if it matters.
  const locks = new Map<string, Semaphore.Semaphore>();
  const withLock = (key: string) => {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermits(1);
  };
  // Port blocks this process handed out, held until teardown or rollback so a block isn't given
  // twice while its card's workspace.set is still on the way.
  const reservedPortBases = new Set<number>();
  // Cards whose run script (the preview) this process started, by that script's id.
  const previewStarted = new Map<CardId, string>();

  const toError = (cardId: string, message: string) => (cause: unknown) =>
    new CardWorkspaceError({ cardId, message, cause });
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:card-workspace:${tag}:${uuid}`)),
      Effect.orDie,
    );

  const readCard = (cardId: CardId) =>
    Effect.gen(function* () {
      const model = yield* snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.mapError(toError(cardId, "Could not read the card.")));
      const card = (model.cards ?? []).find((candidate) => candidate.id === cardId);
      const project =
        card === undefined
          ? undefined
          : model.projects.find(
              (candidate) => candidate.id === card.projectId && candidate.deletedAt === null,
            );
      if (card === undefined || project === undefined) {
        return yield* new CardWorkspaceError({
          cardId,
          message: "The card or its project no longer exists.",
        });
      }
      return { model, card, project };
    });

  const readSettings = (cardId: string) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(toError(cardId, "Could not read the server settings.")),
    );

  const projectScripts = (cardId: CardId, project: OrchestrationProject) =>
    readSettings(cardId).pipe(Effect.map((settings) => resolveProjectScripts(settings, project)));

  /** A git run whose exit code the caller reads. */
  const gitRun = (
    cardId: string,
    cwd: string,
    args: ReadonlyArray<string>,
    env?: Record<string, string>,
  ) =>
    processRunner
      .run({ command: "git", args: ["-C", cwd, ...args], timeout: "2 minutes", env })
      .pipe(Effect.mapError(toError(cardId, `git ${args[0]} could not run.`)));

  const git = (cardId: string, cwd: string, args: ReadonlyArray<string>) =>
    gitRun(cardId, cwd, args).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout.trim())
          : Effect.fail(
              new CardWorkspaceError({
                cardId,
                message: `git ${args.join(" ")} failed: ${output.stderr.trim().slice(-SCRIPT_OUTPUT_TAIL)}`,
              }),
            ),
      ),
    );

  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

  const optionalGit = (cardId: string, cwd: string, args: ReadonlyArray<string>) =>
    git(cardId, cwd, args).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  /** The repository's default branch: origin's HEAD, else whatever the checkout is on. */
  const defaultBranch = (cardId: string, root: string) =>
    Effect.gen(function* () {
      const remoteHead = yield* optionalGit(cardId, root, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      if (Option.isSome(remoteHead)) {
        return remoteHead.value.replace(/^origin\//, "");
      }
      return yield* git(cardId, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    });

  const resolveBaseBranch = (
    cardId: CardId,
    model: OrchestrationReadModel,
    card: OrchestrationCard,
    root: string,
  ) =>
    Effect.gen(function* () {
      return baseBranchOf(card, model) ?? (yield* defaultBranch(cardId, root));
    });

  const refExists = (cardId: string, root: string, ref: string) =>
    gitRun(cardId, root, ["rev-parse", "--verify", "--quiet", ref]).pipe(
      Effect.map((output) => output.code === 0),
    );

  /** Brings origin's copy of the base up to date; offline or local-only bases keep what they have. */
  const fetchBase = (cardId: string, root: string, baseBranch: string) =>
    Effect.gen(function* () {
      if ((yield* gitRun(cardId, root, ["remote", "get-url", "origin"])).code !== 0) {
        return;
      }
      const fetched = yield* gitRun(cardId, root, [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ]);
      if (fetched.code !== 0) {
        yield* Effect.logDebug("card base fetch failed", {
          cardId,
          baseBranch,
          stderr: fetched.stderr.trim(),
        });
      }
    });

  /** The newer of origin/<base> and <base>: origin's when the local branch is missing or behind it. */
  const baseRefOf = (cardId: string, root: string, baseBranch: string) =>
    Effect.gen(function* () {
      if (!(yield* refExists(cardId, root, `refs/remotes/origin/${baseBranch}`))) {
        return baseBranch;
      }
      if (!(yield* refExists(cardId, root, `refs/heads/${baseBranch}`))) {
        return `origin/${baseBranch}`;
      }
      const behind = yield* gitRun(cardId, root, [
        "merge-base",
        "--is-ancestor",
        `refs/heads/${baseBranch}`,
        `refs/remotes/origin/${baseBranch}`,
      ]);
      return behind.code === 0 ? `origin/${baseBranch}` : baseBranch;
    });

  const loadProjectFile = (
    cardId: CardId,
    model: OrchestrationReadModel,
    card: OrchestrationCard,
    project: OrchestrationProject,
  ) =>
    Effect.gen(function* () {
      const root = project.workspaceRoot;
      const baseBranch = yield* resolveBaseBranch(cardId, model, card, root);
      const baseRef = yield* baseRefOf(cardId, root, baseBranch);
      const file = yield* readProjectFile({ root, ref: baseRef }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.mapError((error) => new CardWorkspaceError({ cardId, message: error.message })),
      );
      const checks = projectChecks(file, yield* projectScripts(cardId, project));
      return { baseBranch, baseRef, file, checks } satisfies CardProjectFile;
    });

  /** Removes a worktree and its card branch, tolerating either already being gone. */
  const removeGitWorkspace = (cardId: string, root: string, worktreePath: string, branch: string) =>
    Effect.gen(function* () {
      yield* optionalGit(cardId, root, ["worktree", "remove", "--force", worktreePath]);
      yield* optionalGit(cardId, root, ["worktree", "prune"]);
      // Only branches Iskra named for a card are deleted, never a branch the card was based on.
      if (branch.startsWith("iskra/")) {
        yield* refGuard.serverRefWrite(
          root,
          `refs/heads/${branch}`,
          optionalGit(cardId, root, ["branch", "-D", branch]),
        );
      }
    });

  const shellFor = (command: string) =>
    platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { command: "sh", args: ["-c", command] };

  const quoteShellArg = (value: string) =>
    platform === "win32" ? `"${value.replaceAll('"', "")}"` : `'${value.replaceAll("'", "'\\''")}'`;

  /** The env every card script gets: project paths, the card contract and resource throttling. */
  const scriptEnv = (input: {
    readonly cardId: CardId;
    readonly project: OrchestrationProject;
    readonly worktreePath: string;
    readonly portBase: number;
    readonly file: ProjectFileConfig | null;
    readonly settings: ServerSettings;
  }): Record<string, string> => ({
    ...projectScriptRuntimeEnv({
      project: { cwd: input.project.workspaceRoot },
      worktreePath: input.worktreePath,
    }),
    ...cardScriptEnv({
      cardId: input.cardId,
      portBase: input.portBase,
      portCount: CARD_PORT_BLOCK_SIZE,
      ports: input.file?.ports ?? {},
    }),
    ...hostResourceEnv(input.file?.resourceProfile, input.settings.cardRuntime.resourceProfile),
  });

  /** The project's declared secrets with their values from the secret store. */
  const projectSecrets = (cardId: CardId, project: OrchestrationProject, settings: ServerSettings) =>
    Effect.forEach(settings.cardRuntime.secrets[project.id] ?? [], (declared) =>
      (PROJECT_SECRET_NAME_PATTERN.test(declared.name) && /^[A-Za-z0-9_-]+$/.test(project.id)
        ? secretStore.get(cardSecretStoreName(project.id, declared.name))
        : Effect.succeed(Option.none<Uint8Array>())
      ).pipe(
        Effect.map(
          (value): CardSecret => ({
            name: declared.name,
            exposure: declared.exposure,
            value: Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
          }),
        ),
        Effect.mapError(toError(cardId, `Could not read secret ${declared.name}.`)),
      ),
    );

  /** Runs a setup or archive script to completion; a non-zero exit is a failure. */
  const runAwaitedScript = (
    cardId: string,
    script: ProjectScript,
    cwd: string,
    env: Record<string, string>,
    secrets: ReadonlyArray<CardSecret> = [],
  ) =>
    processRunner
      .run({
        ...shellFor(script.command),
        cwd,
        env,
        timeout: SCRIPT_TIMEOUT,
        maxOutputBytes: 1_048_576,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(toError(cardId, `The ${script.name} script could not start.`)),
        Effect.flatMap((output) =>
          output.code === 0 && !output.timedOut
            ? Effect.void
            : Effect.fail(
                new CardWorkspaceError({
                  cardId,
                  message: output.timedOut
                    ? `The ${script.name} script timed out.`
                    : `The ${script.name} script failed: ${scrubSecrets(
                        (output.stderr || output.stdout).trim(),
                        secrets,
                      ).slice(-SCRIPT_OUTPUT_TAIL)}`,
                }),
              ),
        ),
      );

  /** A free block: not held by an open card or this process, and every one of its ports unbound. */
  const allocatePortBase = (cardId: string, model: OrchestrationReadModel) =>
    Effect.gen(function* () {
      const taken = new Set(
        (model.cards ?? []).flatMap((card) =>
          card.portBase !== null && !isFinishedCardStatus(card.status) ? [card.portBase] : [],
        ),
      );
      for (let block = 0; block < CARD_PORT_BLOCK_LIMIT; block += 1) {
        const base = CARD_PORT_RANGE_START + block * CARD_PORT_BLOCK_SIZE;
        if (taken.has(base) || reservedPortBases.has(base)) {
          continue;
        }
        reservedPortBases.add(base);
        const free = yield* Effect.forEach(
          Array.from({ length: CARD_PORT_BLOCK_SIZE }, (_, offset) => base + offset),
          (port) => net.isPortAvailableOnLoopback(port),
          { concurrency: "unbounded" },
        );
        if (free.every(Boolean)) {
          return base;
        }
        reservedPortBases.delete(base);
      }
      return yield* new CardWorkspaceError({
        cardId,
        message: "No free port block is left for this card.",
      });
    });

  const openCardTerminal = (input: {
    readonly cardId: CardId;
    // Defaults to the card's own terminal thread.
    readonly threadId?: string;
    readonly terminalId: string;
    readonly worktreePath: string;
    readonly env: Record<string, string>;
    readonly command: string;
    readonly label: string;
  }) =>
    Effect.gen(function* () {
      const threadId = input.threadId ?? cardTerminalThreadId(input.cardId);
      yield* terminals
        .open({
          threadId,
          terminalId: input.terminalId,
          cwd: input.worktreePath,
          worktreePath: input.worktreePath,
          env: input.env,
        })
        .pipe(
          Effect.mapError(toError(input.cardId, `Could not open a terminal for ${input.label}.`)),
        );
      yield* terminals
        .write({ threadId, terminalId: input.terminalId, data: `${input.command}\r` })
        .pipe(Effect.mapError(toError(input.cardId, `Could not start ${input.label}.`)));
    });

  const serviceReady = (service: ProjectServiceConfig, port: number) =>
    service.ready.kind === "tcp"
      ? net.hasListenerOnHost(port, "127.0.0.1")
      : Effect.tryPromise(() =>
          // @effect-diagnostics-next-line globalFetchInEffect:off - a loopback readiness probe needs no HttpClient layer.
          fetch(
            `http://127.0.0.1:${port}${service.ready.path.startsWith("/") ? "" : "/"}${service.ready.path}`,
            { signal: AbortSignal.timeout(2_000) },
          ),
        ).pipe(
          Effect.map((response) => response.status < 500),
          Effect.orElseSucceed(() => false),
        );

  /**
   * Brings the project's services up in order under a terminal thread: a service already answering
   * its ready probe is left alone, any other is (re)started and waited on. One caller per thread at
   * a time, so a second caller finds them ready instead of restarting them.
   */
  const ensureServicesAt = (input: {
    readonly cardId: CardId;
    readonly threadId: string;
    readonly worktreePath: string;
    readonly env: Record<string, string>;
    readonly file: ProjectFileConfig;
    readonly portBase: number;
  }) =>
    withLock(`services:${input.threadId}`)(
      Effect.forEach(
        input.file.services,
        (service) =>
          Effect.gen(function* () {
            const port = input.portBase + (input.file.ports[service.port] ?? 0);
            if (yield* serviceReady(service, port)) return;
            const terminalId = `service-${service.name}`;
            yield* terminals
              .close({ threadId: input.threadId, terminalId })
              .pipe(Effect.orElseSucceed(() => undefined));
            yield* openCardTerminal({
              cardId: input.cardId,
              threadId: input.threadId,
              terminalId,
              worktreePath: input.worktreePath,
              env: input.env,
              command: service.start,
              label: service.name,
            });
            const deadline = (yield* Clock.currentTimeMillis) + service.ready.timeoutSeconds * 1_000;
            while (!(yield* serviceReady(service, port))) {
              if ((yield* Clock.currentTimeMillis) > deadline) {
                return yield* new CardWorkspaceError({
                  cardId: input.cardId,
                  message: `Service ${service.name} wasn't ready on port ${port} within ${service.ready.timeoutSeconds}s.`,
                });
              }
              yield* Effect.sleep("500 millis");
            }
          }),
        { discard: true },
      ),
    );

  /** Writes each env file from its template; targets must be gitignored so landing can't commit them. */
  const renderEnvFiles = (input: {
    readonly cardId: CardId;
    readonly worktreePath: string;
    readonly file: ProjectFileConfig;
    readonly portBase: number;
    readonly secrets: ReadonlyArray<CardSecret>;
  }) =>
    Effect.forEach(
      input.file.envFiles,
      (envFile) =>
        Effect.gen(function* () {
          const { cardId, worktreePath } = input;
          const ignored = yield* gitRun(cardId, worktreePath, [
            "check-ignore",
            "--quiet",
            "--no-index",
            envFile.target,
          ]);
          if (ignored.code !== 0) {
            return yield* new CardWorkspaceError({
              cardId,
              message: `The env file ${envFile.target} isn't gitignored; ignore it so what Iskra renders there is never committed.`,
            });
          }
          const template = yield* fileSystem
            .readFileString(path.join(worktreePath, envFile.template))
            .pipe(Effect.mapError(toError(cardId, `Could not read the env template ${envFile.template}.`)));
          const rendered = renderEnvTemplate(template, {
            cardId,
            ports: Object.fromEntries(
              Object.entries(input.file.ports).map(([name, offset]) => [name, input.portBase + offset]),
            ),
            secrets: input.secrets,
          });
          if (!rendered.ok) {
            return yield* new CardWorkspaceError({ cardId, message: rendered.message });
          }
          const target = path.join(worktreePath, envFile.target);
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.flatMap(() => fileSystem.writeFileString(target, rendered.text)),
            Effect.mapError(toError(cardId, `Could not write the env file ${envFile.target}.`)),
          );
        }),
      { discard: true },
    );

  /** A temp copy of the worktree's index with untracked files marked intent-to-add. */
  const intentToAddIndex = (cardId: CardId, worktreePath: string) =>
    Effect.gen(function* () {
      const directory = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "iskra-card-index-" })
        .pipe(Effect.mapError(toError(cardId, "Could not make a temporary index.")));
      const index = path.join(directory, "index");
      const source = path.resolve(
        worktreePath,
        yield* git(cardId, worktreePath, ["rev-parse", "--git-path", "index"]),
      );
      yield* fileSystem
        .copyFile(source, index)
        .pipe(Effect.mapError(toError(cardId, "Could not copy the worktree's index.")));
      const added = yield* gitRun(cardId, worktreePath, ["add", "--intent-to-add", "--", "."], {
        GIT_INDEX_FILE: index,
      });
      if (added.code !== 0) {
        return yield* new CardWorkspaceError({
          cardId,
          message: `git add --intent-to-add failed: ${added.stderr.trim().slice(-SCRIPT_OUTPUT_TAIL)}`,
        });
      }
      return index;
    });

  const diff: CardWorkspace["Service"]["diff"] = (cardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      const baseBranch = yield* resolveBaseBranch(cardId, model, card, project.workspaceRoot);
      if (card.worktreePath === null) {
        return { baseBranch, diff: "" };
      }
      const worktreePath = card.worktreePath;
      const baseRef = yield* baseRefOf(cardId, project.workspaceRoot, baseBranch);
      const mergeBase = yield* git(cardId, worktreePath, ["merge-base", baseRef, "HEAD"]);
      // Against the working tree through a temp index, so uncommitted edits and new files count.
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const index = yield* intentToAddIndex(cardId, worktreePath);
          return yield* processRunner
            .run({
              command: "git",
              args: ["-C", worktreePath, "diff", mergeBase],
              env: { GIT_INDEX_FILE: index },
              timeout: "2 minutes",
              maxOutputBytes: 1_048_576,
              outputMode: "truncate",
            })
            .pipe(Effect.mapError(toError(cardId, "git diff could not run.")));
        }),
      );
      if (output.code !== 0) {
        return yield* new CardWorkspaceError({
          cardId,
          message: `git diff failed: ${output.stderr.trim().slice(-SCRIPT_OUTPUT_TAIL)}`,
        });
      }
      return { baseBranch, diff: output.stdout };
    });

  /** Keeps the log's last 1MB on disk and returns its last few kilobytes. */
  const capLog = (logPath: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const size = Number((yield* fileSystem.stat(logPath)).size);
        const kept = Math.min(size, CHECK_LOG_MAX_BYTES);
        const handle = yield* fileSystem.open(logPath, { flag: "r" });
        yield* handle.seek(size - kept, "start");
        const bytes = kept === 0 ? Option.none() : yield* handle.readAlloc(kept);
        const content = Option.getOrElse(bytes, () => new Uint8Array());
        if (size > CHECK_LOG_MAX_BYTES) {
          yield* fileSystem.writeFile(logPath, content);
        }
        return new TextDecoder().decode(content.slice(-8_192));
      }),
    );

  const runCheck = (input: {
    readonly check: ProjectCheck;
    readonly command: string;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly logDir: string;
    readonly secrets: ReadonlyArray<CardSecret>;
  }) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const logPath = path.join(
        input.logDir,
        `${input.check.id.replaceAll(/[^A-Za-z0-9_-]/g, "_")}-${uuid}.log`,
      );
      // Output goes straight to the log so a timed-out check still leaves its tail; niced so a
      // suite doesn't starve the agents and the UI.
      const shell =
        platform === "win32"
          ? {
              command: "cmd.exe",
              args: ["/d", "/s", "/c", `${input.command} > "%ISKRA_CHECK_LOG%" 2>&1`],
            }
          : {
              command: "nice",
              args: ["-n", "10", "sh", "-c", `exec >"$ISKRA_CHECK_LOG" 2>&1\n${input.command}`],
            };
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* processRunner
        .run({
          ...shell,
          cwd: input.cwd,
          env: { ...input.env, ISKRA_CHECK_LOG: logPath },
          timeout: `${Math.round(input.check.timeoutMinutes * 60_000)} millis`,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 65_536,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((output) => ({ exitCode: output.code, timedOut: output.timedOut, error: "" })),
          Effect.catch((error) =>
            Effect.succeed({ exitCode: null, timedOut: false, error: error.message }),
          ),
        );
      const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
      const tail = yield* capLog(logPath).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      return {
        id: input.check.id,
        name: input.check.name,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs,
        // Color codes are stripped from what agents and people read; the log file keeps them.
        logTail: scrubSecrets(
          stripTerminalControl(
            `${Option.getOrElse(tail, () => "")}${outcome.error === "" ? "" : `\n${outcome.error}`}`,
          ),
          input.secrets,
        )
          .trim()
          .slice(-SCRIPT_OUTPUT_TAIL),
        logArtifactPath: Option.isSome(tail) ? logPath : null,
      } satisfies CardCheckResult;
    });

  const checkPassed = (result: CardCheckResult) => !result.timedOut && result.exitCode === 0;

  const runChecks: CardWorkspace["Service"]["runChecks"] = (input) =>
    Effect.gen(function* () {
      const { cardId } = input;
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null || card.portBase === null) {
        return { passed: false, summary: "The card has no worktree to check.", results: [] };
      }
      const config = yield* loadProjectFile(cardId, model, card, project);
      const checks = (input.checks ?? config.checks).filter((check) => check.source !== "ci");
      if (checks.length === 0) {
        return {
          passed: false,
          summary: "The project has no checks to run on this machine.",
          results: [],
        };
      }
      const settings = yield* readSettings(cardId);
      // Scrubbing only: check processes never receive secrets.
      const secrets = yield* projectSecrets(cardId, project, settings).pipe(
        Effect.orElseSucceed((): ReadonlyArray<CardSecret> => []),
      );
      const env = scriptEnv({
        cardId,
        project,
        worktreePath: card.worktreePath,
        portBase: card.portBase,
        file: config.file,
        settings,
      });
      return yield* runInOrder({
        cardId,
        steps: checks.map((check) => ({
          check,
          command:
            input.scope === "targeted" && check.targetedCommand !== null
              ? check.targetedCommand.replaceAll("{filter}", quoteShellArg(input.filter ?? ""))
              : check.command,
        })),
        cwd: card.worktreePath,
        env,
        logFolder: "checks",
        secrets,
      });
    });

  /** Runs commands in order under the card's evidence logs, stopping at the first failure. */
  const runInOrder = (input: {
    readonly cardId: CardId;
    readonly steps: ReadonlyArray<{ readonly check: ProjectCheck; readonly command: string }>;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly logFolder: "checks" | "journeys";
    readonly secrets: ReadonlyArray<CardSecret>;
  }) =>
    Effect.gen(function* () {
      const logDir = path.join(
        serverConfig.attachmentsDir,
        `card-evidence-${input.cardId}`,
        input.logFolder,
      );
      yield* fileSystem
        .makeDirectory(logDir, { recursive: true })
        .pipe(Effect.mapError(toError(input.cardId, "Could not make the card's log folder.")));
      const results: Array<CardCheckResult> = [];
      for (const { check, command } of input.steps) {
        const result = yield* runCheck({
          check,
          command,
          cwd: input.cwd,
          env: input.env,
          logDir,
          secrets: input.secrets,
        });
        results.push(result);
        if (!checkPassed(result)) {
          break;
        }
      }
      const failed = results.find((result) => !checkPassed(result));
      return {
        passed: failed === undefined,
        summary:
          failed === undefined
            ? `${results.map((result) => result.name).join(", ")} passed.`
            : `${failed.name} ${
                failed.timedOut
                  ? "timed out"
                  : failed.exitCode === null
                    ? "could not run"
                    : `failed with exit code ${failed.exitCode}`
              }.\n\n${failed.logTail}`,
        results,
      } satisfies CardChecksRun;
    });

  const runJourneys: CardWorkspace["Service"]["runJourneys"] = (input) =>
    Effect.gen(function* () {
      const { cardId } = input;
      const { model, card, project } = yield* readCard(cardId);
      const config = yield* loadProjectFile(cardId, model, card, project);
      const journeys = config.file?.journeys ?? [];
      if (journeys.length === 0) {
        return { passed: true, summary: "The project declares no journeys.", results: [] };
      }
      const at =
        input.snapshot ??
        (card.worktreePath === null || card.portBase === null
          ? null
          : { path: card.worktreePath, portBase: card.portBase, ensureServices: ensureServices(cardId) });
      if (at === null) {
        return { passed: false, summary: "The card has no worktree to run journeys in.", results: [] };
      }
      // Journeys drive the running app, so its services must answer first.
      yield* at.ensureServices;
      const settings = yield* readSettings(cardId);
      const secrets = yield* projectSecrets(cardId, project, settings).pipe(
        Effect.orElseSucceed((): ReadonlyArray<CardSecret> => []),
      );
      return yield* runInOrder({
        cardId,
        steps: journeys.map((journey) => ({
          check: {
            ...journey,
            source: "local" as const,
            ciName: null,
            targetedCommand: null,
            heavy: true,
          },
          command: journey.command,
        })),
        cwd: at.path,
        env: scriptEnv({
          cardId,
          project,
          worktreePath: at.path,
          portBase: at.portBase,
          file: config.file,
          settings,
        }),
        logFolder: "journeys",
        secrets,
      });
    });

  const serviceHealth: CardWorkspace["Service"]["serviceHealth"] = (cardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null || card.portBase === null) return [];
      const portBase = card.portBase;
      const { file } = yield* loadProjectFile(cardId, model, card, project);
      const preview = previewStarted.get(cardId);
      const entries: ReadonlyArray<Omit<CardServiceHealth, "up">> = [
        ...(file?.services ?? []).map((service) => ({
          kind: "service" as const,
          name: service.name,
          port: portBase + (file?.ports[service.port] ?? 0),
        })),
        ...(preview === undefined
          ? []
          : [{ kind: "preview" as const, name: preview, port: portBase + (file?.ports["web"] ?? 0) }]),
      ];
      return yield* Effect.forEach(
        entries,
        (entry) =>
          net.hasListenerOnHost(entry.port, "127.0.0.1").pipe(Effect.map((up) => ({ ...entry, up }))),
        { concurrency: "unbounded" },
      );
    });

  const changedFiles: CardWorkspace["Service"]["changedFiles"] = (cardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null) {
        return [];
      }
      const baseBranch = yield* resolveBaseBranch(cardId, model, card, project.workspaceRoot);
      const baseRef = yield* baseRefOf(cardId, project.workspaceRoot, baseBranch);
      const mergeBase = yield* git(cardId, card.worktreePath, ["merge-base", baseRef, "HEAD"]);
      const tracked = yield* git(cardId, card.worktreePath, ["diff", "--name-only", mergeBase]);
      const untracked = yield* git(cardId, card.worktreePath, [
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);
      return [...new Set([...lines(tracked), ...lines(untracked)])];
    });

  const openCardChangedFiles: CardWorkspace["Service"]["openCardChangedFiles"] = (projectId) =>
    Effect.gen(function* () {
      const model = yield* snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.mapError(toError(projectId, "Could not read the project's cards.")));
      const open = (model.cards ?? []).filter(
        (card) =>
          card.projectId === projectId &&
          card.worktreePath !== null &&
          !isFinishedCardStatus(card.status),
      );
      return yield* Effect.forEach(open, (card) =>
        changedFiles(card.id).pipe(
          Effect.map((files) => ({ cardId: card.id, files })),
          Effect.orElseSucceed(() => ({ cardId: card.id, files: [] as ReadonlyArray<string> })),
        ),
      );
    });

  /** The worktree that has `branch` checked out, from `git worktree list --porcelain`. */
  const worktreeOfBranch = (porcelain: string, branch: string): string | null => {
    for (const block of porcelain.split("\n\n")) {
      const entry = block.split("\n");
      const worktree = entry.find((line) => line.startsWith("worktree "));
      if (worktree !== undefined && entry.includes(`branch refs/heads/${branch}`)) {
        return worktree.slice("worktree ".length);
      }
    }
    return null;
  };

  const landUnlocked = (cardId: CardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null || card.branch === null) {
        return yield* new CardWorkspaceError({ cardId, message: "The card has no worktree to land." });
      }
      const root = project.workspaceRoot;
      const worktree = card.worktreePath;
      const branch = card.branch;
      const policy = projectOrchestrationOf(project);
      const baseBranch = yield* resolveBaseBranch(cardId, model, card, root);

      // What the agent left uncommitted lands too, as one commit named for the card.
      if ((yield* git(cardId, worktree, ["status", "--porcelain"])).length > 0) {
        yield* git(cardId, worktree, ["add", "--all"]);
        yield* git(cardId, worktree, ["commit", "--quiet", "--message", card.title]);
      }
      yield* fetchBase(cardId, root, baseBranch);
      const baseRef = yield* baseRefOf(cardId, root, baseBranch);

      const rebaseCheckAndMerge = Effect.gen(function* () {
        const rebase = yield* gitRun(cardId, worktree, ["rebase", baseRef]);
        if (rebase.code !== 0) {
          const conflicted = yield* optionalGit(cardId, worktree, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          yield* optionalGit(cardId, worktree, ["rebase", "--abort"]);
          return {
            kind: "conflict" as const,
            baseBranch,
            files: Option.isSome(conflicted) ? lines(conflicted.value) : [],
          };
        }

        const checks = yield* admission.run(
          {
            cardId,
            projectId: project.id,
            priority: card.priority,
            label: `Checks before landing ${card.title}`,
            kind: "landing",
          },
          runChecks({ cardId, scope: "full" }),
        );
        if (checks.results.length === 0 ? !policy.checksWaived : !checks.passed) {
          return {
            kind: "checksFailed" as const,
            summary:
              checks.results.length === 0
                ? "The project has no checks to run on this machine, and they aren't waived."
                : checks.summary,
            results: checks.results,
          };
        }
        // The rebased code is what lands, so declared journeys run again against it.
        const journeys = yield* admission.run(
          {
            cardId,
            projectId: project.id,
            priority: card.priority,
            label: `Journeys before landing ${card.title}`,
            kind: "journey",
          },
          runJourneys({ cardId }),
        );
        if (!journeys.passed) {
          return { kind: "checksFailed" as const, summary: journeys.summary, results: journeys.results };
        }
        const files = lines(yield* git(cardId, worktree, ["diff", "--name-only", baseRef, "HEAD"]));

        // Fast-forward the base where it is checked out, so that checkout moves with it; else move the ref.
        return yield* withLock(`project:${project.id}`)(
          Effect.gen(function* () {
            const checkedOutAt = worktreeOfBranch(
              yield* git(cardId, root, ["worktree", "list", "--porcelain"]),
              baseBranch,
            );
            const merge = yield* refGuard.serverRefWrite(
              root,
              `refs/heads/${baseBranch}`,
              checkedOutAt === null
                ? gitRun(cardId, root, ["fetch", "--quiet", ".", `${branch}:${baseBranch}`])
                : gitRun(cardId, checkedOutAt, ["merge", "--ff-only", "--quiet", branch]),
            );
            if (merge.code !== 0) {
              return {
                kind: "notMerged" as const,
                message: `Fast-forwarding ${baseBranch} failed: ${merge.stderr.trim().slice(-SCRIPT_OUTPUT_TAIL)}`,
              };
            }
            return { kind: "landed" as const, baseBranch, files };
          }),
        );
      });

      // One card at a time lands changes to an exclusive path; locks are taken in a stable order.
      const touched = lines(yield* git(cardId, worktree, ["diff", "--name-only", `${baseRef}...HEAD`]));
      let serialized: Effect.Effect<CardLandResult, CardWorkspaceError> = rebaseCheckAndMerge;
      for (const { glob } of exclusivePathConflicts(touched, policy).toSorted((a, b) =>
        a.glob.localeCompare(b.glob),
      )) {
        serialized = withLock(`exclusive:${project.id}:${glob}`)(serialized);
      }
      return yield* serialized;
    });

  const ensureUnlocked = (cardId: CardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.branch !== null && card.worktreePath !== null && card.portBase !== null) {
        return { branch: card.branch, worktreePath: card.worktreePath, portBase: card.portBase };
      }
      if (isFinishedCardStatus(card.status)) {
        return yield* new CardWorkspaceError({
          cardId,
          message: "A card that has landed or been abandoned cannot get a workspace.",
        });
      }
      const root = project.workspaceRoot;
      yield* fetchBase(cardId, root, yield* resolveBaseBranch(cardId, model, card, root));
      const { baseRef, file } = yield* loadProjectFile(cardId, model, card, project);
      const settings = yield* readSettings(cardId);
      const branch = cardBranchName(card);
      const worktreePath = path.join(
        serverConfig.worktreesDir,
        path.basename(root),
        branch.replaceAll("/", "-"),
      );

      const portBase = yield* withLock(`project:${project.id}`)(
        Effect.gen(function* () {
          const { model: current } = yield* readCard(cardId);
          const base = yield* allocatePortBase(cardId, current);
          yield* refGuard
            .serverRefWrite(
              root,
              `refs/heads/${branch}`,
              git(cardId, root, ["worktree", "add", "-b", branch, worktreePath, baseRef]),
            )
            .pipe(Effect.tapError(() => Effect.sync(() => reservedPortBases.delete(base))));
          return base;
        }),
      );
      const rollback = Effect.gen(function* () {
        yield* terminals
          .close({ threadId: cardTerminalThreadId(cardId), deleteHistory: true })
          .pipe(Effect.orElseSucceed(() => undefined));
        yield* removeGitWorkspace(cardId, root, worktreePath, branch);
        reservedPortBases.delete(portBase);
      });

      // Everything before the agent session: env files, setup (with secrets), services.
      const prepare = Effect.gen(function* () {
        const secrets = yield* projectSecrets(cardId, project, settings);
        const env = scriptEnv({ cardId, project, worktreePath, portBase, file, settings });
        if (file !== null) {
          yield* renderEnvFiles({ cardId, worktreePath, file, portBase, secrets });
        }
        const setup = setupProjectScript(yield* projectScripts(cardId, project));
        if (setup !== null) {
          // Only setup sees secret values; later scripts run code the agent may have changed.
          const secretEnv = Object.fromEntries(
            secrets.flatMap((secret) => (secret.value === null ? [] : [[secret.name, secret.value]])),
          );
          yield* admission.run(
            {
              cardId,
              projectId: project.id,
              priority: card.priority,
              label: `Setting up ${card.title}`,
              kind: "setup",
            },
            runAwaitedScript(cardId, setup, worktreePath, { ...env, ...secretEnv }, secrets),
          );
        }
        if (file !== null) {
          yield* ensureServicesAt({
            cardId,
            threadId: cardTerminalThreadId(cardId),
            worktreePath,
            env,
            file,
            portBase,
          });
        }
        yield* engine
          .dispatch({
            type: "card.workspace.set",
            commandId: yield* commandId("set"),
            cardId,
            branch,
            worktreePath,
            portBase,
          })
          .pipe(Effect.mapError(toError(cardId, "Could not record the card's workspace.")));
      });
      // A worktree whose preparation failed is not a workspace; remove it so the next try starts clean.
      yield* prepare.pipe(Effect.tapError(() => rollback));
      return { branch, worktreePath, portBase };
    });

  const ensureServices: CardWorkspace["Service"]["ensureServices"] = (cardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null || card.portBase === null) {
        return yield* new CardWorkspaceError({
          cardId,
          message: "The card has no worktree to run services in.",
        });
      }
      const { file } = yield* loadProjectFile(cardId, model, card, project);
      if (file === null || file.services.length === 0) return;
      yield* ensureServicesAt({
        cardId,
        threadId: cardTerminalThreadId(cardId),
        worktreePath: card.worktreePath,
        env: scriptEnv({
          cardId,
          project,
          worktreePath: card.worktreePath,
          portBase: card.portBase,
          file,
          settings: yield* readSettings(cardId),
        }),
        file,
        portBase: card.portBase,
      });
    });

  const snapshot: CardWorkspace["Service"]["snapshot"] = (cardId, headSha) =>
    Effect.gen(function* () {
      if (!/^[0-9a-f]{7,64}$/i.test(headSha)) {
        return yield* new CardWorkspaceError({ cardId, message: `'${headSha}' isn't a commit sha.` });
      }
      const { model, card, project } = yield* readCard(cardId);
      const root = project.workspaceRoot;
      const { file } = yield* loadProjectFile(cardId, model, card, project);
      const settings = yield* readSettings(cardId);
      const scripts = yield* projectScripts(cardId, project);
      const suffix = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "").slice(-8);
      const worktreePath = path.join(
        serverConfig.worktreesDir,
        path.basename(root),
        `snapshot-${cardSlug(cardId)}-${headSha.slice(0, 7)}-${suffix}`,
      );
      const threadId = `card-snapshot:${cardId}:${suffix}`;

      const portBase = yield* withLock(`project:${project.id}`)(
        Effect.gen(function* () {
          const { model: current } = yield* readCard(cardId);
          const base = yield* allocatePortBase(cardId, current);
          // Detached: no branch is made, so nothing done in the snapshot can move a card's ref.
          yield* git(cardId, root, ["worktree", "add", "--detach", worktreePath, headSha]).pipe(
            Effect.tapError(() => Effect.sync(() => reservedPortBases.delete(base))),
          );
          return base;
        }),
      );
      // No secrets anywhere in a snapshot: env files and scripts get ports and paths only.
      const env = scriptEnv({ cardId, project, worktreePath, portBase, file, settings });

      let released = false;
      const release = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.gen(function* () {
          const archive = archiveProjectScript(scripts);
          if (archive !== null) {
            yield* runAwaitedScript(cardId, archive, worktreePath, env).pipe(
              Effect.catch((error) => Effect.logWarning(error.message)),
            );
          }
          yield* terminals
            .close({ threadId, deleteHistory: true })
            .pipe(Effect.orElseSucceed(() => undefined));
          yield* optionalGit(cardId, root, ["worktree", "remove", "--force", worktreePath]);
          yield* optionalGit(cardId, root, ["worktree", "prune"]);
          reservedPortBases.delete(portBase);
        });
      });

      const ensureSnapshotServices =
        file === null
          ? Effect.void
          : ensureServicesAt({ cardId, threadId, worktreePath, env, file, portBase });

      yield* Effect.gen(function* () {
        if (file !== null) {
          yield* renderEnvFiles({ cardId, worktreePath, file, portBase, secrets: [] });
        }
        const setup = setupProjectScript(scripts);
        if (setup !== null) {
          yield* admission.run(
            {
              cardId,
              projectId: project.id,
              priority: card.priority,
              label: `Setting up a snapshot of ${card.title}`,
              kind: "setup",
            },
            runAwaitedScript(cardId, setup, worktreePath, env),
          );
        }
        yield* ensureSnapshotServices;
      }).pipe(Effect.tapError(() => release));

      return {
        path: worktreePath,
        portBase,
        ports: Object.fromEntries(
          Object.entries(file?.ports ?? {}).map(([name, offset]) => [name, portBase + offset]),
        ),
        ensureServices: ensureSnapshotServices,
        release,
      } satisfies CardSnapshot;
    });

  const teardownUnlocked = (cardId: CardId) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.branch === null || card.worktreePath === null || card.portBase === null) {
        return;
      }
      const root = project.workspaceRoot;
      const archive = archiveProjectScript(yield* projectScripts(cardId, project));
      if (archive !== null) {
        const file = yield* loadProjectFile(cardId, model, card, project).pipe(
          Effect.map((config) => config.file),
          Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(null))),
        );
        const env = scriptEnv({
          cardId,
          project,
          worktreePath: card.worktreePath,
          portBase: card.portBase,
          file,
          settings: yield* readSettings(cardId),
        });
        yield* runAwaitedScript(cardId, archive, card.worktreePath, env).pipe(
          // The worktree goes anyway: a finished card must not keep its branch because cleanup failed.
          Effect.tapError((error) => Effect.logWarning(error.message)),
          Effect.orElseSucceed(() => undefined),
        );
      }
      // Closing the card's terminals also stops its run scripts and services.
      yield* terminals
        .close({ threadId: cardTerminalThreadId(cardId), deleteHistory: true })
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* removeGitWorkspace(cardId, root, card.worktreePath, card.branch);
      yield* engine
        .dispatch({
          type: "card.workspace.clear",
          commandId: yield* commandId("clear"),
          cardId,
        })
        .pipe(Effect.mapError(toError(cardId, "Could not clear the card's workspace.")));
      reservedPortBases.delete(card.portBase);
      previewStarted.delete(cardId);
    });

  const runScript: CardWorkspace["Service"]["runScript"] = ({ cardId, scriptId }) =>
    Effect.gen(function* () {
      const { model, card, project } = yield* readCard(cardId);
      if (card.worktreePath === null || card.portBase === null) {
        return yield* new CardWorkspaceError({
          cardId,
          message: "Start work on the card before running its scripts.",
        });
      }
      const script = (yield* projectScripts(cardId, project)).find(
        (candidate) => candidate.id === scriptId,
      );
      if (script === undefined) {
        return yield* new CardWorkspaceError({
          cardId,
          message: `The project has no script '${scriptId}'.`,
        });
      }
      const terminalId = `script-${script.id}`;
      if (script.exclusive === true) {
        for (const other of model.cards ?? []) {
          if (
            other.id !== card.id &&
            other.projectId === card.projectId &&
            other.worktreePath !== null
          ) {
            yield* terminals
              .close({ threadId: cardTerminalThreadId(other.id), terminalId })
              .pipe(Effect.orElseSucceed(() => undefined));
          }
        }
      }
      const { file } = yield* loadProjectFile(cardId, model, card, project);
      yield* openCardTerminal({
        cardId,
        terminalId,
        worktreePath: card.worktreePath,
        env: scriptEnv({
          cardId,
          project,
          worktreePath: card.worktreePath,
          portBase: card.portBase,
          file,
          settings: yield* readSettings(cardId),
        }),
        command: script.command,
        label: script.name,
      });
      if (script.role === "run") previewStarted.set(cardId, script.id);
      return { terminalId };
    });

  const worker = yield* makeDrainableWorker((cardId: CardId) =>
    withLock(`card:${cardId}`)(teardownUnlocked(cardId)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card workspace teardown failed", {
              cardId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start = Effect.fn("CardWorkspace.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "card.status-changed" && isFinishedCardStatus(event.payload.to)
          ? worker.enqueue(event.payload.cardId)
          : Effect.void,
      ),
    );
  });

  return {
    start,
    ensure: (cardId) => withLock(`card:${cardId}`)(ensureUnlocked(cardId)),
    snapshot,
    ensureServices,
    diff,
    runChecks,
    runJourneys,
    serviceHealth,
    changedFiles,
    land: (cardId) => withLock(`card:${cardId}`)(landUnlocked(cardId)),
    withCardLock: (cardId, effect) => withLock(`card:${cardId}`)(effect),
    runScript,
    projectFile: (cardId) =>
      readCard(cardId).pipe(
        Effect.flatMap(({ model, card, project }) => loadProjectFile(cardId, model, card, project)),
      ),
    openCardChangedFiles,
  } satisfies CardWorkspace["Service"];
});

export const layer = Layer.effect(CardWorkspace, make);
