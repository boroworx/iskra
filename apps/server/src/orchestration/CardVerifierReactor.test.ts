import {
  AgentId,
  CardId,
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type CardVerdict,
  type HoldoutScenario,
  type OrchestrationAgent,
  type OrchestrationCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ServerProvider,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as CardVerifierReactor from "./CardVerifierReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { HoldoutStore } from "./HoldoutStore.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-verify");
const cardId = CardId.make("card-health");
const headSha = "abc1234def5678";

const agent = (name: string, instance: string, model: string, roles: OrchestrationAgent["roles"]) =>
  ({
    id: AgentId.make(`agent-${name}`),
    projectId,
    name,
    avatar: null,
    roleTags: [],
    rolePrompt: "",
    modelSelection: { instanceId: ProviderInstanceId.make(instance), model },
    capabilities: ["read", "write", "shell"],
    roles,
    verifyWith: null,
    blueprint: DEFAULT_AGENT_BLUEPRINT,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }) satisfies OrchestrationAgent;

const builder = agent("builder", "claudeAgent", "claude-a", ["builder"]);
const verifierOc = agent("verifier-oc", "opencode", "gpt-5", ["verifier"]);

const card = {
  id: cardId,
  projectId,
  title: "Health route",
  spec: "Add GET /health.",
  status: "inReview",
  priority: 2,
  delegateAgentId: builder.id,
  branch: "iskra/health",
  worktreePath: "/tmp/card-health",
  acceptance: {
    state: "confirmed",
    criteria: [
      { id: "c1", text: "GET /health answers 200.", verification: "automated" },
      { id: "c2", text: "The body is JSON.", verification: "automated" },
    ],
  },
  evidence: {
    evidenceId: "evidence-1",
    headSha,
    purpose: "review",
    passed: true,
    checkCount: 1,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: now,
  },
  verification: {
    state: "pending",
    headSha,
    verdictId: null,
    verifier: null,
    satisfaction: null,
    override: null,
  },
} as unknown as OrchestrationCard;

const scenarios: ReadonlyArray<HoldoutScenario> = [
  {
    scenarioId: "h1",
    title: "Health says ok",
    kind: "text",
    body: "GET /health returns the word ok",
    command: null,
    timeoutMinutes: 5,
  },
  {
    scenarioId: "h2",
    title: "Health is JSON",
    kind: "command",
    body: "",
    command: "node holdout-status.js",
    timeoutMinutes: 5,
  },
];
/** Everything a value would say once serialized, for asserting what it never contains. */
const textOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const SECRETS = ["Health says ok", "returns the word ok", "Health is JSON", "holdout-status", "expected JSON, got text"];

const readModel = {
  projects: [
    { id: projectId, orchestration: { ...DEFAULT_PROJECT_ORCHESTRATION, verifier: { mode: "on" } } },
  ],
  cards: [card],
  agents: [builder, verifierOc],
  threads: [],
  channels: [],
  liveRuns: [],
} as unknown as OrchestrationReadModel;

const provider = (instance: string, models: ReadonlyArray<string>, status: ServerProvider["status"]) =>
  ({
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make(instance),
    enabled: true,
    status,
    models: models.map((slug) => ({ slug, name: slug })),
  }) as unknown as ServerProvider;

it.effect(
  "verifies a card in review from a snapshot, keeps hidden scenarios out of everything stored, and returns a failed verdict with counts only",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const commands: Array<OrchestrationCommand> = [];
        const runs: Array<ProcessRunInput> = [];
        const snapshots: Array<readonly [string, string]> = [];
        let released = 0;
        const returned = yield* Deferred.make<void>();

        const doubles = Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                if (command.type === "card.work.return") yield* Deferred.succeed(returned, undefined);
                return { sequence: commands.length };
              }),
            subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
          }),
          Layer.mock(ProjectionSnapshotQuery)({ getCommandReadModel: () => Effect.succeed(readModel) }),
          Layer.mock(CardWorkspace.CardWorkspace)({
            snapshot: (id, sha) =>
              Effect.sync(() => {
                snapshots.push([id, sha]);
                return {
                  path: "/tmp/card-health-verify-abc1234",
                  portBase: 43_000,
                  ports: { web: 43_001 },
                  ensureServices: Effect.void,
                  release: Effect.sync(() => {
                    released += 1;
                  }),
                };
              }),
            diff: () => Effect.succeed({ baseBranch: "main", diff: "+app.get('/health', () => 'ok')\n" }),
          }),
          Layer.mock(HostAdmission)({ run: (_job, effect) => effect }),
          Layer.mock(ProcessRunner)({
            run: (input) =>
              Effect.sync(() => {
                runs.push(input);
                return {
                  stdout: "expected JSON, got text",
                  stderr: "",
                  code: 1,
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                } as unknown as ProcessRunOutput;
              }),
          }),
          // OpenCode is down, so the builder's template verifies on its other Claude model.
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([
              provider("claudeAgent", ["claude-a", "claude-b"], "ready"),
              provider("opencode", ["gpt-5"], "error"),
            ]),
          }),
          Layer.mock(HoldoutStore)({ list: () => Effect.succeed(scenarios) }),
        );
        const layer = CardVerifierReactor.layer.pipe(
          Layer.provide(doubles),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* CardVerifierReactor.CardVerifierReactor;
          // Starting picks up the card already waiting in review.
          yield* reactor.start();
          yield* reactor.drain;

          expect(commands.find((command) => command.type === "card.verifier.select")).toMatchObject({
            cardId,
            headSha,
            verifier: {
              agentId: builder.id,
              instanceId: "claudeAgent",
              model: "claude-b",
              reason: { code: "sameProviderVerifier" },
            },
          });
          expect(snapshots).toEqual([[cardId, headSha]]);
          expect(runs).toMatchObject([
            {
              command: "sh",
              args: ["-c", "node holdout-status.js"],
              cwd: "/tmp/card-health-verify-abc1234",
              env: { ISKRA_PORT_WEB: "43001" },
            },
          ]);

          const session = commands.find((command) => command.type === "card.session.record");
          expect(session).toMatchObject({ role: "verifier", capabilities: ["read"] });
          expect(textOf(session)).toContain("[hidden scenario h1]");
          expect(commands.find((command) => command.type === "thread.create")).toMatchObject({
            worktreePath: "/tmp/card-health-verify-abc1234",
            modelSelection: { model: "claude-b" },
          });
          const turn = commands.find((command) => command.type === "thread.turn.start");
          const turnText = turn?.type === "thread.turn.start" ? turn.message.text : "";
          expect(turnText).toContain("GET /health returns the word ok");
          expect(turnText).toContain("expected JSON, got text");
          // Only the verifier's own turn carries a scenario; every other command stays clean.
          for (const command of commands.filter((entry) => entry.type !== "thread.turn.start")) {
            for (const secret of SECRETS) expect(textOf(command)).not.toContain(secret);
          }

          const verdict: CardVerdict = {
            verdictId: "verdict-1",
            cardId,
            headSha,
            verifier: {
              agentId: builder.id,
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-b",
              reason: { code: "sameProviderVerifier", text: "fallback" },
            },
            criteria: [
              { criterionId: "c1", pass: true, evidence: "journey passed", note: "" },
              {
                criterionId: "c2",
                pass: false,
                evidence: "curl",
                note: "Returns text, so GET /health returns the word ok instead of JSON.",
              },
            ],
            diffJudge: { matchesCriteria: true, concerns: [] },
            scenarios: [
              { scenarioId: "h1", satisfied: true },
              { scenarioId: "h2", satisfied: false },
            ],
            passed: false,
            recordedAt: now,
          };
          yield* Queue.offer(events, {
            type: "card.verdict-recorded",
            payload: { cardId, verdict },
          } as unknown as OrchestrationEvent);
          yield* Deferred.await(returned);

          expect(released).toBe(1);
          expect(commands.some((command) => command.type === "thread.session.stop")).toBe(true);
          const feedback = commands.find(
            (command) => command.type === "card.activity.record" && command.deliverTo === "builder",
          );
          const feedbackText = textOf(feedback);
          expect(feedbackText).toContain("1 hidden scenario failed");
          expect(feedbackText).toContain("c2 (The body is JSON.)");
          for (const secret of SECRETS) expect(feedbackText).not.toContain(secret);
          expect(commands.at(-1)).toMatchObject({ type: "card.work.return", cardId, round: "review" });
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// A real verifier paraphrased a hidden scenario in a diff concern; redaction can't catch that.
it("keeps the verifier's diff concerns out of the builder's feedback", () => {
  const { headline, body } = CardVerifierReactor.verifierFeedback({
    card: {
      acceptance: { criteria: [{ id: "c1", text: "GET /health answers 200." }] },
    } as unknown as Pick<OrchestrationCard, "acceptance">,
    verdict: {
      criteria: [{ criterionId: "c1", pass: true, evidence: "journey", note: "Answers 200." }],
      diffJudge: {
        matchesCriteria: true,
        concerns: ["The hidden expectation that /health returns JSON conflicts with c1."],
      },
      scenarios: [{ scenarioId: "h1", satisfied: false }],
    } as unknown as Pick<CardVerdict, "criteria" | "diffJudge" | "scenarios">,
    scenarios: [{ scenarioId: "h1", title: "Health is JSON", body: "", command: "node check.js" }],
  });
  expect(headline).toBe("1 hidden scenario failed");
  expect(body).toContain("1 hidden scenario failed");
  expect(body).not.toContain("JSON");
  expect(body).not.toContain("Concern");
});
