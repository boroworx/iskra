import { CardId, ThreadId } from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { HeavyJobEntry } from "./HostAdmission.ts";
import {
  checksHung,
  hungJobAction,
  memoryPressureActions,
  watchOwnerRun,
  watchServices,
  WATCHDOG_LIMITS,
  type OwnerRunFacts,
  type ServiceProbe,
  type WatchdogRule,
} from "./watchdogRules.ts";

const MINUTE = 60_000;
const now = 10 * 60 * MINUTE;

const facts = (overrides: Partial<OwnerRunFacts> = {}): OwnerRunFacts => ({
  threadId: ThreadId.make("thread-owner"),
  cardId: CardId.make("card"),
  cardStatus: "inProgress",
  spentUsd: 1,
  budgetCapUsd: 10,
  turnActive: true,
  awaitingInput: false,
  sessionSince: now - MINUTE,
  lastEventAt: now - MINUTE,
  toolRunningSince: null,
  tools: [],
  workStartedAt: now - 60 * MINUTE,
  strikes: new Map(),
  ...overrides,
});

const struck = (rule: WatchdogRule, at: number) => new Map([[rule, { count: 1, at }]]);
const calls = (key: string, count: number, failed = false, from = now - 30 * MINUTE) =>
  Array.from({ length: count }, (_, index) => ({ key, failed, at: from + index }));

/** The action's kind, rule and reason code, or null. */
const verdict = (input: OwnerRunFacts) => {
  const action = watchOwnerRun(input, now);
  return action === null
    ? null
    : [action.kind, action.rule, action.reason.code, action.kind === "pause" ? action.session : null];
};

describe("watchOwnerRun", () => {
  it.each<[string, OwnerRunFacts, ReturnType<typeof verdict>]>([
    ["a busy session", facts(), null],
    ["a quiet turn under 20 minutes", facts({ lastEventAt: now - 19 * MINUTE }), null],
    ["a quiet turn at 20 minutes", facts({ lastEventAt: now - 20 * MINUTE }), ["nudge", "stalled", "stalled", null]],
    [
      "a quiet turn already nudged",
      facts({ lastEventAt: now - 30 * MINUTE, strikes: struck("stalled", now - 10 * MINUTE) }),
      null,
    ],
    ["a quiet turn at 45 minutes", facts({ lastEventAt: now - 45 * MINUTE }), ["stop", "hardStall", "stalled", null]],
    [
      "a long tool call under an hour",
      facts({ lastEventAt: now - 50 * MINUTE, toolRunningSince: now - 50 * MINUTE }),
      null,
    ],
    [
      "a tool call running an hour",
      facts({ lastEventAt: now - 60 * MINUTE, toolRunningSince: now - 60 * MINUTE }),
      ["stop", "hardStall", "stalled", null],
    ],
    ["a question under 10 minutes", facts({ awaitingInput: true, sessionSince: now - 9 * MINUTE }), null],
    [
      "a question over 10 minutes",
      facts({ awaitingInput: true, sessionSince: now - 10 * MINUTE }),
      ["pause", "awaitingInput", "awaitingInput", "stop"],
    ],
    ["the same call 3 times", facts({ tools: calls("Bash:pnpm test", 3) }), null],
    [
      "the same call 4 times in the last 10",
      facts({ tools: [...calls("Read", 6), ...calls("Bash:pnpm test", 4)] }),
      ["nudge", "repeatedAction", "repeatedAction", null],
    ],
    [
      "the same call 4 more times after a nudge",
      facts({
        tools: [...calls("Bash:pnpm test", 4), ...calls("Bash:pnpm test", 4, false, now - 5 * MINUTE)],
        strikes: struck("repeatedAction", now - 10 * MINUTE),
      }),
      ["pause", "repeatedAction", "stuck", "stop"],
    ],
    [
      "repetition only before the nudge",
      facts({ tools: calls("Bash:pnpm test", 4), strikes: struck("repeatedAction", now - 10 * MINUTE) }),
      null,
    ],
    [
      "5 failed calls in a row",
      facts({ tools: [...calls("Read", 1), ...calls("a", 1, true), ...calls("b", 1, true), ...calls("c", 1, true), ...calls("d", 1, true), ...calls("e", 1, true)] }),
      ["nudge", "errorLoop", "errorLoop", null],
    ],
    [
      "4 failed calls after a success",
      facts({ tools: [...calls("a", 1, true), ...calls("Read", 1), ...calls("b", 1, true), ...calls("c", 1, true), ...calls("d", 1, true), ...calls("e", 1, true)] }),
      null,
    ],
    ["idle in progress under 5 minutes", facts({ turnActive: false, sessionSince: now - 4 * MINUTE }), null],
    [
      "idle in progress for 5 minutes",
      facts({ turnActive: false, sessionSince: now - 5 * MINUTE }),
      ["nudge", "idleInProgress", "idleInProgress", null],
    ],
    [
      "idle again after the nudge",
      facts({ turnActive: false, sessionSince: now - 5 * MINUTE, strikes: struck("idleInProgress", now - 20 * MINUTE) }),
      ["pause", "idleInProgress", "stuck", "stop"],
    ],
    ["idle in review", facts({ turnActive: false, cardStatus: "inReview", sessionSince: now - 30 * MINUTE }), null],
    [
      "in progress for 8 hours",
      facts({ workStartedAt: now - WATCHDOG_LIMITS.maxCardMs }),
      ["pause", "wallClock", "wallClock", "interrupt"],
    ],
    ["spending at the cap", facts({ spentUsd: 10 }), null],
    ["spending at 120% of the cap", facts({ spentUsd: 12 }), ["pause", "budgetBreaker", "budgetBreaker", "interrupt"]],
  ])("%s", (_name, input, expected) => {
    expect(verdict(input)).toEqual(expected);
  });
});

describe("checksHung", () => {
  it("counts a check run hung only past every check's limit", () => {
    expect(checksHung({ state: "running", updatedAt: now - 61 * MINUTE }, now)).toBe(false);
    expect(checksHung({ state: "running", updatedAt: now - 62 * MINUTE }, now)).toBe(true);
    expect(checksHung({ state: "passed", updatedAt: now - 90 * MINUTE }, now)).toBe(false);
    expect(checksHung(null, now)).toBe(false);
  });
});

describe("memoryPressureActions", () => {
  const owners = [
    { threadId: ThreadId.make("urgent"), priority: 1 as const, startedAt: "2026-01-01T00:00:00.000Z" },
    { threadId: ThreadId.make("low-old"), priority: 4 as const, startedAt: "2026-01-01T00:00:00.000Z" },
    { threadId: ThreadId.make("low-new"), priority: 4 as const, startedAt: "2026-01-01T01:00:00.000Z" },
  ];
  const running = [
    { job: { projectId: "p", priority: 4, label: "checks", kind: "checks" }, enqueuedAt: 0, startedAt: 0 },
  ] as unknown as Parameters<typeof memoryPressureActions>[0]["admission"]["running"];

  it("waits a minute of pressure, then cancels a heavy job and interrupts the lowest-priority newest turn", () => {
    expect(
      memoryPressureActions({
        admission: { running, waiting: [], memoryPressureSince: now - 59_000 },
        activeOwners: owners,
        now,
      }),
    ).toEqual({ cancelHeavyJob: false, interrupt: null });
    expect(
      memoryPressureActions({
        admission: { running, waiting: [], memoryPressureSince: now - MINUTE },
        activeOwners: owners,
        now,
      }),
    ).toEqual({ cancelHeavyJob: true, interrupt: "low-new" });
    expect(
      memoryPressureActions({
        admission: { running: [], waiting: [], memoryPressureSince: now - MINUTE },
        activeOwners: [],
        now,
      }),
    ).toEqual({ cancelHeavyJob: false, interrupt: null });
  });
});

describe("hungJobAction", () => {
  const entry = (kind: string, startedAt: number | null) =>
    ({
      id: 1,
      job: { projectId: "p", priority: 0, label: "Card", kind },
      enqueuedAt: 0,
      startedAt,
    }) as unknown as HeavyJobEntry;

  it("starts a hung job over once, then stops it; setup counts as hung sooner", () => {
    expect(hungJobAction(entry("checks", now - 61 * MINUTE), 0, now)).toBeNull();
    expect(hungJobAction(entry("checks", now - 62 * MINUTE), 0, now)).toMatchObject({
      cancel: "requeue",
      reason: { code: "checksHung" },
    });
    expect(hungJobAction(entry("journey", now - 62 * MINUTE), 1, now)).toMatchObject({
      cancel: "stop",
      reason: {
        code: "checksHung",
        text: "The journeys hung again after being started over; it was stopped.",
      },
    });
    expect(hungJobAction(entry("setup", now - 12 * MINUTE), 0, now)).toMatchObject({
      cancel: "requeue",
      reason: { code: "setupTimedOut" },
    });
    expect(hungJobAction(entry("setup", null), 0, now)).toBeNull();
  });
});

describe("watchServices", () => {
  const probe = (up: boolean): ServiceProbe => ({ kind: "service", name: "api", port: 42_000, up });

  it("reports a port down for a minute once per outage, and forgets it once it answers", () => {
    const first = watchServices({ probes: [probe(false)], outages: new Map(), now });
    expect(first.report).toEqual([]);
    const second = watchServices({ probes: [probe(false)], outages: first.outages, now: now + MINUTE });
    expect(second.report.map((down) => down.reason.code)).toEqual(["serviceDown"]);
    expect(
      watchServices({ probes: [probe(false)], outages: second.outages, now: now + 5 * MINUTE }).report,
    ).toEqual([]);
    expect(watchServices({ probes: [probe(true)], outages: second.outages, now }).outages.size).toBe(0);
    const preview = watchServices({
      probes: [{ kind: "preview", name: "dev", port: 42_003, up: false }],
      outages: new Map([["preview:dev", { since: now - MINUTE, reported: false }]]),
      now,
    });
    expect(preview.report[0]?.reason).toEqual({
      code: "previewDown",
      text: "The preview stopped listening on port 42003; Iskra is restarting it.",
    });
  });
});
