import {
  CardId,
  ThreadId,
  TurnId,
  type OrchestrationCard,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { environmentSessionCapOf, planStarts, type PlanStartsInput } from "./cardQueue.ts";
import {
  applyCommands,
  assign,
  backend,
  cardIn,
  createAgent,
  createCard,
  createProject,
  guardProject,
  now,
  onCard,
} from "./decider.testkit.ts";

/** A guarded project with one approved, assigned card whose spec is past the plan gate. */
const makeQueue = Effect.gen(function* () {
  const base = yield* applyCommands([
    createProject(),
    guardProject(),
    createAgent(backend),
    createCard(),
    onCard("card.approve"),
    assign(backend),
  ]);
  const baseCard = { ...(cardIn(base) as OrchestrationCard), specState: "skipped" as const };

  const card = (id: string, fields: Partial<OrchestrationCard> = {}): OrchestrationCard => ({
    ...baseCard,
    id: CardId.make(id),
    ...fields,
  });

  const plan = (
    cards: ReadonlyArray<OrchestrationCard>,
    options: Partial<Omit<PlanStartsInput, "readModel">> & {
      readonly runs?: ReadonlyArray<ReturnType<typeof ownerRun>>;
      readonly sessionCap?: number | null;
      readonly openAgentPrCap?: number;
    } = {},
  ) => {
    const readModel: OrchestrationReadModel = {
      ...base,
      projects: base.projects.map((project) => ({
        ...project,
        orchestration: {
          ...project.orchestration!,
          sessionCap: options.sessionCap ?? null,
          openAgentPrCap: options.openAgentPrCap ?? 5,
        },
      })),
      cards,
      liveRuns: (options.runs ?? []).map((entry) => entry.run),
      threads: (options.runs ?? []).map((entry) => entry.thread),
    };
    const result = planStarts({
      readModel,
      environmentSessionCap: options.environmentSessionCap ?? 3,
      starting: options.starting ?? new Set(),
      retryAt: options.retryAt ?? new Map(),
      memoryPressure: options.memoryPressure ?? false,
      now: options.now ?? 0,
    });
    return {
      ...result,
      started: result.start.map((started) => started.id),
      reasons: Object.fromEntries(
        result.waits.map((wait) => [wait.cardId, wait.reason?.code ?? null]),
      ),
    };
  };

  return { card, plan };
});

/** An owner run on `cardId`; a turn id means it is mid-turn, null that it sits settled. */
const ownerRun = (cardId: string, turnId: string | null) => {
  const threadId = ThreadId.make(`thread-${cardId}`);
  return {
    run: {
      threadId,
      role: "owner" as const,
      channelId: null,
      cardId: CardId.make(cardId),
      agentId: backend,
      startedAt: now,
    },
    // Only the session matters to the queue.
    thread: {
      id: threadId,
      session: {
        threadId,
        status: turnId === null ? "ready" : "running",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: turnId === null ? null : TurnId.make(turnId),
        lastError: null,
        updatedAt: now,
      },
    } as unknown as OrchestrationThread,
  };
};

describe("environmentSessionCapOf", () => {
  it.each([
    [{ cores: 8, totalMemBytes: 16 * 1024 ** 3, override: null }, 2],
    [{ cores: 24, totalMemBytes: 64 * 1024 ** 3, override: null }, 6],
    [{ cores: 2, totalMemBytes: 4 * 1024 ** 3, override: null }, 1],
    [{ cores: 2, totalMemBytes: 4 * 1024 ** 3, override: 4 }, 4],
  ])("%j → %d", (input, expected) => {
    expect(environmentSessionCapOf(input)).toBe(expected);
  });
});

it.layer(NodeServices.layer)("planStarts", (it) => {
  it.effect("starts by priority, urgent first and unprioritised last, until the machine is full", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const result = plan(
        [
          card("none", { priority: 0, queuedAt: "2026-01-01T00:00:01.000Z" }),
          card("low", { priority: 4 }),
          card("urgent", { priority: 1, queuedAt: "2026-01-01T00:00:09.000Z" }),
          card("urgent-earlier", { priority: 1, queuedAt: "2026-01-01T00:00:02.000Z" }),
        ],
        { environmentSessionCap: 3 },
      );
      expect(result.started).toEqual(["urgent-earlier", "urgent", "low"]);
      expect(result.reasons).toEqual({ none: "waitingForSlot" });
    }),
  );

  it.effect("restarts a card in progress with no owner before new work", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const result = plan(
        [card("urgent", { priority: 1 }), card("restart", { status: "inProgress", priority: 4 })],
        { environmentSessionCap: 1 },
      );
      expect(result.started).toEqual(["restart"]);
    }),
  );

  it.effect("counts only sessions in a turn, and stops idle owners of cards in review", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const idle = ownerRun("reviewing", null);
      const busy = ownerRun("working", "turn-1");
      const cards = [
        card("reviewing", { status: "inReview" }),
        card("working", { status: "inProgress" }),
        card("next"),
        card("after"),
      ];
      const result = plan(cards, { environmentSessionCap: 2, runs: [idle, busy] });
      expect(result.started).toEqual(["next"]);
      expect(result.reasons).toEqual({ after: "waitingForSlot" });
      expect(result.stop).toEqual([idle.run.threadId]);
      // A ready card whose owner session already recorded is not started twice.
      expect(plan([card("working")], { runs: [busy] }).started).toEqual([]);
      // A start in flight holds its slot too.
      const inFlight = plan(cards, {
        environmentSessionCap: 2,
        runs: [busy],
        starting: new Set([CardId.make("next")]),
      });
      expect(inFlight.started).toEqual([]);
    }),
  );

  it.effect("holds new work at the project's session cap and its open pull request limit", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      expect(plan([card("a"), card("b")], { sessionCap: 1 }).reasons).toEqual({
        b: "waitingForSlot",
      });
      const pr = card("pr", {
        status: "inReview",
        landing: {
          mode: "pullRequest",
          url: "https://github.com/o/r/pull/1",
          number: 1,
          headSha: null,
          draft: false,
          linkedAt: now,
        },
      });
      const result = plan([pr, card("new"), card("restart", { status: "inProgress" })], {
        openAgentPrCap: 1,
      });
      expect(result.started).toEqual(["restart"]);
      expect(result.reasons).toEqual({ new: "reviewCapacity" });
    }),
  );

  it.effect("starts only cards a person approved to run, and says when one is blocked", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const blocker = card("blocker", { status: "inReview" });
      const result = plan([
        blocker,
        card("blocked", { relations: [{ kind: "blockedBy", cardId: blocker.id }] }),
        card("draft", { specState: "draft" }),
        card("unconfirmed", { acceptance: { criteria: [], state: "draft" } }),
        card("paused", {
          paused: { reason: { code: "pausedByPerson", text: "Paused." }, by: "human", pausedAt: now },
        }),
        card("unassigned", { delegateAgentId: null }),
        card("broke", { spentUsd: 11, budgetCapUsd: 10 }),
        card("triage", { status: "triage" }),
        card("go"),
      ]);
      expect(result.started).toEqual(["go"]);
      expect(result.reasons).toEqual({ blocked: "blocked" });
    }),
  );

  it.effect("waits out a failed start's backoff, and defers every start under memory pressure", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const cards = [card("retry")];
      const retryAt = new Map([[CardId.make("retry"), 60_000]]);
      expect(plan(cards, { retryAt, now: 59_999 }).started).toEqual([]);
      expect(plan(cards, { retryAt, now: 60_000 }).started).toEqual(["retry"]);
      expect(plan(cards, { memoryPressure: true }).reasons).toEqual({ retry: "waitingForMemory" });
    }),
  );

  it.effect("notes a wait only when it changes, and clears its own once the card no longer waits", () =>
    Effect.gen(function* () {
      const { card, plan } = yield* makeQueue;
      const waiting = {
        code: "waitingForSlot",
        text: "All 1 session slots on this machine are busy; the card starts when one frees.",
        since: now,
      };
      const busy = ownerRun("working", "turn-1");
      const cards = [
        card("working", { status: "inProgress" }),
        card("queued", { waitReason: waiting }),
      ];
      expect(plan(cards, { environmentSessionCap: 1, runs: [busy] }).waits).toEqual([]);
      expect(plan(cards, { environmentSessionCap: 2, runs: [busy] }).reasons).toEqual({
        queued: null,
      });
      // Someone else's wait, such as machine capacity for its checks, is left alone.
      const checks = card("checks", {
        status: "inReview",
        waitReason: { code: "waitingForCapacity", text: "Waiting for machine capacity", since: now },
      });
      expect(plan([checks]).waits).toEqual([]);
    }),
  );
});
