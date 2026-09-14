import {
  CARD_PORT_BLOCK_SIZE,
  CommandId,
  type CardId,
  type OrchestrationCard,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectScript,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import { HostProcessPlatform } from "@iskra/shared/hostProcess";
import * as Net from "@iskra/shared/Net";
import {
  archiveProjectScript,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@iskra/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
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

export interface CardWorkspaceInfo {
  readonly branch: string;
  readonly worktreePath: string;
  readonly portBase: number;
}

/**
 * A card's workspace: its own git worktree and branch, and a block of ports its
 * scripts receive as ISKRA_PORT. `ensure` creates it when work starts, running
 * the project's setup script and removing the worktree again if setup fails.
 * When a card lands or is abandoned the workspace is torn down: the archive
 * script runs, the card's terminals close, and the worktree and branch go.
 */
export class CardWorkspace extends Context.Service<
  CardWorkspace,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly ensure: (cardId: CardId) => Effect.Effect<CardWorkspaceInfo, CardWorkspaceError>;
    readonly teardown: (cardId: CardId) => Effect.Effect<void, CardWorkspaceError>;
    readonly runScript: (input: {
      readonly cardId: CardId;
      readonly scriptId: string;
    }) => Effect.Effect<{ readonly terminalId: string }, CardWorkspaceError>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardWorkspace") {}

/** The first port handed to a card; blocks of CARD_PORT_BLOCK_SIZE go up from here. */
const CARD_PORT_RANGE_START = 42_000;
const CARD_PORT_BLOCK_LIMIT = 500;
const SCRIPT_TIMEOUT = "10 minutes";
const SCRIPT_OUTPUT_TAIL = 2_000;

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

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner;
  const net = yield* Net.NetService;
  const terminals = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  // One workspace change at a time, so two cards never take the same ports or branch.
  const semaphore = yield* Semaphore.make(1);

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

  const projectScripts = (cardId: CardId, project: OrchestrationProject) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => resolveProjectScripts(settings, project)),
      Effect.mapError(toError(cardId, "Could not read the project's scripts.")),
    );

  const git = (cardId: string, cwd: string, args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args: ["-C", cwd, ...args], timeout: "2 minutes" }).pipe(
      Effect.mapError(toError(cardId, `git ${args[0]} could not run.`)),
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

  /** Removes a worktree and its card branch, tolerating either already being gone. */
  const removeGitWorkspace = (cardId: string, root: string, worktreePath: string, branch: string) =>
    Effect.gen(function* () {
      yield* optionalGit(cardId, root, ["worktree", "remove", "--force", worktreePath]);
      yield* optionalGit(cardId, root, ["worktree", "prune"]);
      // Only branches Iskra named for a card are deleted, never a branch the card was based on.
      if (branch.startsWith("iskra/")) {
        yield* optionalGit(cardId, root, ["branch", "-D", branch]);
      }
    });

  const shellFor = (command: string) =>
    platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { command: "sh", args: ["-c", command] };

  const scriptEnv = (project: OrchestrationProject, worktreePath: string, portBase: number) =>
    projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath,
      extraEnv: {
        ISKRA_PORT: String(portBase),
        ISKRA_PORT_COUNT: String(CARD_PORT_BLOCK_SIZE),
      },
    });

  /** Runs a setup or archive script to completion; a non-zero exit is a failure. */
  const runAwaitedScript = (
    cardId: string,
    script: ProjectScript,
    cwd: string,
    env: Record<string, string>,
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
                    : `The ${script.name} script failed: ${(output.stderr || output.stdout).trim().slice(-SCRIPT_OUTPUT_TAIL)}`,
                }),
              ),
        ),
      );

  const allocatePortBase = (cardId: string, model: OrchestrationReadModel) =>
    Effect.gen(function* () {
      const taken = new Set(
        (model.cards ?? []).flatMap((card) =>
          card.portBase !== null && !isFinishedCardStatus(card.status) ? [card.portBase] : [],
        ),
      );
      for (let block = 0; block < CARD_PORT_BLOCK_LIMIT; block += 1) {
        const base = CARD_PORT_RANGE_START + block * CARD_PORT_BLOCK_SIZE;
        // ponytail: probes only the block's first port; probe all ten if card scripts collide in practice.
        if (!taken.has(base) && (yield* net.isPortAvailableOnLoopback(base))) {
          return base;
        }
      }
      return yield* new CardWorkspaceError({
        cardId,
        message: "No free port block is left for this card.",
      });
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
      const parent =
        card.parentCardId === null
          ? undefined
          : (model.cards ?? []).find((candidate) => candidate.id === card.parentCardId);
      // A sub-card starts from its parent's branch; otherwise the card's base or the repository default.
      const base = card.baseBranch ?? parent?.branch ?? (yield* defaultBranch(cardId, root));
      const branch = cardBranchName(card);
      const portBase = yield* allocatePortBase(cardId, model);
      const worktreePath = path.join(
        serverConfig.worktreesDir,
        path.basename(root),
        branch.replaceAll("/", "-"),
      );

      yield* git(cardId, root, ["worktree", "add", "-b", branch, worktreePath, base]);
      const rollback = removeGitWorkspace(cardId, root, worktreePath, branch);
      const setup = setupProjectScript(
        yield* projectScripts(cardId, project).pipe(Effect.tapError(() => rollback)),
      );
      if (setup !== null) {
        yield* runAwaitedScript(
          cardId,
          setup,
          worktreePath,
          scriptEnv(project, worktreePath, portBase),
        ).pipe(
          // A worktree whose setup failed is not a workspace; remove it so the next try starts clean.
          Effect.tapError(() => rollback),
        );
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
        .pipe(
          Effect.mapError(toError(cardId, "Could not record the card's workspace.")),
          Effect.tapError(() => rollback),
        );
      return { branch, worktreePath, portBase };
    });

  const teardownUnlocked = (cardId: CardId) =>
    Effect.gen(function* () {
      const { card, project } = yield* readCard(cardId);
      if (card.branch === null || card.worktreePath === null || card.portBase === null) {
        return;
      }
      const root = project.workspaceRoot;
      const archive = archiveProjectScript(yield* projectScripts(cardId, project));
      if (archive !== null) {
        yield* runAwaitedScript(
          cardId,
          archive,
          card.worktreePath,
          scriptEnv(project, card.worktreePath, card.portBase),
        ).pipe(
          // The worktree goes anyway: a finished card must not keep its branch because cleanup failed.
          Effect.tapError((error) => Effect.logWarning(error.message)),
          Effect.orElseSucceed(() => undefined),
        );
      }
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
      const threadId = cardTerminalThreadId(card.id);
      yield* terminals
        .open({
          threadId,
          terminalId,
          cwd: card.worktreePath,
          worktreePath: card.worktreePath,
          env: scriptEnv(project, card.worktreePath, card.portBase),
        })
        .pipe(Effect.mapError(toError(cardId, `Could not open a terminal for ${script.name}.`)));
      yield* terminals
        .write({ threadId, terminalId, data: `${script.command}\r` })
        .pipe(Effect.mapError(toError(cardId, `Could not start ${script.name}.`)));
      return { terminalId };
    });

  const worker = yield* makeDrainableWorker((cardId: CardId) =>
    semaphore.withPermits(1)(teardownUnlocked(cardId)).pipe(
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
    ensure: (cardId) => semaphore.withPermits(1)(ensureUnlocked(cardId)),
    teardown: (cardId) => semaphore.withPermits(1)(teardownUnlocked(cardId)),
    runScript,
    drain: worker.drain,
  } satisfies CardWorkspace["Service"];
});

export const layer = Layer.effect(CardWorkspace, make);
