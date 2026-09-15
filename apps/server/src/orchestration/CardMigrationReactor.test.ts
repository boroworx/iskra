import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  MIGRATION_SAMPLE_SIZE,
  ProjectId,
  ProviderInstanceId,
  type CardMigration,
  type OrchestrationCard,
  type OrchestrationEvent,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { REVIEW_REQUESTED_CODE } from "./CardEvidence.ts";
import * as CardMigrationReactor from "./CardMigrationReactor.ts";
import { migrationStep } from "./CardMigrationReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const item = (
  key: string,
  state: CardMigration["items"][number]["state"] = "pending",
  childCardId: string | null = null,
) => ({
  key,
  state,
  childCardId: childCardId === null ? null : CardId.make(childCardId),
});

const migrationCard = (
  status: OrchestrationCard["status"],
  phase: CardMigration["phase"],
  items: CardMigration["items"],
  fields: Partial<OrchestrationCard> = {},
) =>
  ({
    status,
    paused: null,
    delegateAgentId: AgentId.make("agent-builder"),
    specState: "approved",
    acceptance: { criteria: [], state: "confirmed" },
    migration: {
      enumerateCommand: "node list.js",
      instructions: "",
      phase,
      items,
      sampleSize: MIGRATION_SAMPLE_SIZE,
    },
    ...fields,
  }) as OrchestrationCard;

const childCard = (
  id: string,
  status: OrchestrationCard["status"],
  paused: OrchestrationCard["paused"] = null,
) => ({
  id: CardId.make(id),
  status,
  paused,
});

describe("migrationStep", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((key) => item(key));
  it.each([
    [
      "an approved ready migration starts",
      migrationCard("ready", "enumerating", []),
      [],
      { kind: "start" },
    ],
    [
      "a ready migration without its agent waits",
      migrationCard("ready", "enumerating", [], { delegateAgentId: null }),
      [],
      null,
    ],
    [
      "a paused migration waits",
      migrationCard("inProgress", "sweeping", six, {
        paused: { reason: { code: "x", text: "x" }, by: "human", pausedAt: now },
      }),
      [],
      null,
    ],
    [
      "it lists its items first",
      migrationCard("inProgress", "enumerating", []),
      [],
      { kind: "enumerate" },
    ],
    [
      "then samples them spread out",
      migrationCard("inProgress", "enumerating", six),
      [],
      { kind: "phase", phase: "sampling", keys: ["a", "c", "e"] },
    ],
    [
      "it waits while a sampled child still works",
      migrationCard("inProgress", "sampling", [
        item("a", "running", "ca"),
        item("b"),
        item("c", "running", "cc"),
      ]),
      [childCard("ca", "inReview"), childCard("cc", "inProgress")],
      null,
    ],
    [
      "it tunes once every sampled child reached review, landed, or stopped for a person",
      migrationCard("inProgress", "sampling", [
        item("a", "landed", "ca"),
        item("b"),
        item("c", "running", "cc"),
        item("d", "running", "cd"),
      ]),
      [
        childCard("ca", "landed"),
        childCard("cc", "inReview"),
        childCard("cd", "inProgress", {
          reason: { code: "fixRoundsExhausted", text: "x" },
          by: "system",
          pausedAt: now,
        }),
      ],
      { kind: "tune" },
    ],
    ["tuning waits for the person", migrationCard("inProgress", "tuning", six), [], null],
    [
      "a sweep keeps running items within capacity, batch after batch",
      migrationCard("inProgress", "sweeping", [
        item("a", "landed"),
        item("b", "running"),
        item("c"),
        item("d"),
        item("e"),
        item("f"),
      ]),
      [],
      { kind: "phase", phase: "sweeping", keys: ["c", "d"] },
    ],
    [
      "a full machine starts nothing more",
      migrationCard("inProgress", "sweeping", [
        item("a", "running"),
        item("b", "running"),
        item("c", "running"),
        item("d"),
      ]),
      [],
      null,
    ],
    [
      "a blocked item doesn't stop the migration finishing",
      migrationCard("inProgress", "sweeping", [
        item("a", "landed"),
        item("b", "blocked"),
        item("c", "landed"),
      ]),
      [],
      { kind: "phase", phase: "done", keys: [] },
    ],
    [
      "a finished sweep asks for review",
      migrationCard("inProgress", "done", six),
      [],
      { kind: "review" },
    ],
  ] as const)("%s", (_name, card, children, expected) => {
    expect(migrationStep(card, children, 3)).toEqual(expected);
  });
});

let randomCalls = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    randomCalls += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, randomCalls);
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

const ITEMS = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

const layer = CardMigrationReactor.layer.pipe(
  Layer.provide(
    Layer.mock(CardWorkspace.CardWorkspace)({ enumerateItems: () => Effect.succeed(ITEMS) }),
  ),
  Layer.provide(ServerSettings.layerTest({ cardRuntime: { environmentSessionCap: 3 } })),
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
  ),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-migration-test-" }),
  ),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("CardMigrationReactor", (it) => {
  it.effect(
    "samples three items, tunes, then sweeps the rest while a blocked item doesn't stop it",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* (yield* CardMigrationReactor.CardMigrationReactor).start();
        /** A fresh tap on domain events: subscribe before the action, then await what it causes. */
        const tap = Effect.map(engine.subscribeDomainEvents, nextEventOn);
        let commands = 0;
        const commandId = () => CommandId.make(`cmd-migration-${(commands += 1)}`);
        const projectId = ProjectId.make("project-migration");
        const builder = AgentId.make("agent-migration-builder");
        const migrationId = CardId.make("card-migration");
        yield* engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "migration",
          workspaceRoot: "/tmp/migration",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "project.orchestration.set",
          commandId: commandId(),
          projectId,
          orchestration: {
            ...DEFAULT_PROJECT_ORCHESTRATION,
            landing: "local",
            verifier: { mode: "off" },
            sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
          },
        });
        yield* engine.dispatch({
          type: "agent.create",
          commandId: commandId(),
          agentId: builder,
          projectId,
          name: "builder",
          roleTags: [],
          rolePrompt: "",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-4-5",
          },
          capabilities: ["read", "write"],
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "card.create",
          commandId: commandId(),
          cardId: migrationId,
          projectId,
          title: "Use the logger",
          spec: "",
          tags: [],
          kind: "migration",
          migration: {
            enumerateCommand: "node list-files.js",
            instructions: "Replace console.log with the logger.",
          },
          criteria: [
            {
              id: "c1",
              text: "No console.log calls remain in the file.",
              verification: "automated",
            },
          ],
          createdAt: now,
        });
        // The migration's own branch, so its children land into it.
        yield* engine.dispatch({
          type: "card.workspace.set",
          commandId: commandId(),
          cardId: migrationId,
          branch: "iskra/use-the-logger",
          worktreePath: "/tmp/worktrees/use-the-logger",
          portBase: 42000,
        });

        const model = snapshotQuery.getCommandReadModel();
        const migrationOf = Effect.map(model, (current) =>
          current.cards!.find((card) => card.id === migrationId)!,
        );
        const childOf = (key: string) =>
          Effect.map(model, (current) =>
            current.cards!.find(
              (card) => card.parentCardId === migrationId && card.planKey === key,
            )!,
          );
        const toReview = Effect.fn("toReview")(function* (key: string) {
          const child = yield* childOf(key);
          yield* engine.dispatch({
            type: "card.work.start",
            commandId: commandId(),
            cardId: child.id,
          });
          yield* engine.dispatch({
            type: "card.workspace.set",
            commandId: commandId(),
            cardId: child.id,
            branch: `iskra/${key}`,
            worktreePath: `/tmp/worktrees/${key}`,
            portBase: 42010 + commands,
          });
          yield* engine.dispatch({
            type: "card.evidence.record",
            commandId: commandId(),
            cardId: child.id,
            evidenceId: `evidence-${key}`,
            headSha: "abc1234",
            purpose: "review",
            items: [
              {
                itemId: "check:test",
                kind: "check",
                source: "local",
                name: "test",
                criterionId: null,
                exitCode: 0,
                timedOut: false,
                durationMs: 1,
                logTail: "ok",
                artifactPath: null,
                unavailable: null,
              },
            ],
            flags: [],
            risks: null,
            recordedAt: now,
          });
          yield* engine.dispatch({
            type: "card.review.enter",
            commandId: commandId(),
            cardId: child.id,
            headSha: "abc1234",
          });
        });
        const land = Effect.fn("land")(function* (key: string) {
          const child = yield* childOf(key);
          yield* engine.dispatch({
            type: "card.merge.approve",
            commandId: commandId(),
            cardId: child.id,
          });
          yield* engine.dispatch({
            type: "card.land",
            commandId: commandId(),
            cardId: child.id,
            landedSha: "abc1234",
          });
        });
        const block = Effect.fn("block")(function* (key: string) {
          const child = yield* childOf(key);
          yield* engine.dispatch({
            type: "card.work.start",
            commandId: commandId(),
            cardId: child.id,
          });
          yield* engine.dispatch({
            type: "card.pause.system",
            commandId: commandId(),
            cardId: child.id,
            reason: { code: "fixRoundsExhausted", text: "CI failed twice." },
          });
        });
        const itemUpdated =
          (key: string, state: string) =>
          (event: Extract<OrchestrationEvent, { type: "card.migration-items-updated" }>) =>
            event.payload.items.some((entry) => entry.key === key && entry.state === state);

        // Approve & start: it lists six items and samples three spread across them.
        let next = yield* tap;
        const sampling = next(
          "card.migration-phase-changed",
          (event) => event.payload.phase === "sampling",
        );
        yield* engine.dispatch({
          type: "card.approve",
          commandId: commandId(),
          cardId: migrationId,
          delegateAgentId: builder,
        });
        expect((yield* sampling).payload.started.map((started) => started.key)).toEqual([
          "a.ts",
          "c.ts",
          "e.ts",
        ]);
        expect(yield* childOf("c.ts")).toMatchObject({
          status: "ready",
          delegateAgentId: builder,
          baseBranch: "iskra/use-the-logger",
          spec: "Replace console.log with the logger.\n\nItem: c.ts",
        });

        // Two reach review and one uses up its fix rounds: a person tunes.
        next = yield* tap;
        const blockedC = next("card.migration-items-updated", itemUpdated("c.ts", "blocked"));
        yield* toReview("a.ts");
        yield* block("c.ts");
        yield* blockedC;
        const tuning = next(
          "card.checkpoint-requested",
          (event) => event.payload.cardId === migrationId,
        );
        yield* toReview("e.ts");
        yield* tuning;
        expect((yield* migrationOf).migration?.phase).toBe("tuning");

        next = yield* tap;
        const landedA = next("card.migration-items-updated", itemUpdated("a.ts", "landed"));
        const landedE = next("card.migration-items-updated", itemUpdated("e.ts", "landed"));
        yield* land("a.ts");
        yield* land("e.ts");
        yield* landedA;
        yield* landedE;

        // Redirecting rewrites the instructions, and the sweep starts the rest within the machine's three slots.
        next = yield* tap;
        const sweeping = next(
          "card.migration-phase-changed",
          (event) => event.payload.phase === "sweeping",
        );
        yield* engine.dispatch({
          type: "card.checkpoint.resolve",
          commandId: commandId(),
          cardId: migrationId,
          decision: "redirect",
          note: "Replace console.log with logger.info, keeping the message.",
        });
        expect((yield* sweeping).payload.started.map((started) => started.key)).toEqual([
          "b.ts",
          "d.ts",
          "f.ts",
        ]);
        expect((yield* childOf("d.ts")).spec).toBe(
          "Replace console.log with logger.info, keeping the message.\n\nItem: d.ts",
        );

        // One sweep item is blocked too; the rest land and the migration asks for review.
        next = yield* tap;
        const done = next(
          "card.migration-phase-changed",
          (event) => event.payload.phase === "done",
        );
        const review = next(
          "card.activity-recorded",
          (event) =>
            event.payload.cardId === migrationId &&
            event.payload.reason?.code === REVIEW_REQUESTED_CODE,
        );
        yield* block("b.ts");
        yield* toReview("d.ts");
        yield* land("d.ts");
        yield* toReview("f.ts");
        yield* land("f.ts");
        yield* done;
        expect((yield* review).payload.author).toEqual({ kind: "agent", id: builder });
        expect(
          (yield* migrationOf).migration?.items.map((entry) => [entry.key, entry.state]),
        ).toEqual([
          ["a.ts", "landed"],
          ["b.ts", "blocked"],
          ["c.ts", "blocked"],
          ["d.ts", "landed"],
          ["e.ts", "landed"],
          ["f.ts", "landed"],
        ]);
      }),
  );
});
