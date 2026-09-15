import { describe, expect, it } from "vite-plus/test";

import { firstCommitSha, outcomeOf, type LandedSignals } from "./outcomeRules.ts";

const landedAt = "2026-01-01T00:00:00.000Z";
const day = (n: number) => new Date(Date.parse(landedAt) + n * 24 * 60 * 60 * 1000).toISOString();

const quiet: LandedSignals = {
  landedAt,
  revertLanded: false,
  revertOnBase: false,
  ciFailureOnBase: false,
  mergedOnHost: false,
  foreignCommit: false,
};

const landed = { status: "landed", outcome: null, paused: null } as const;
const pausedBy = (code: string) =>
  ({ reason: { code, text: code }, by: { kind: "system", id: "system" }, pausedAt: landedAt }) as never;

describe("outcomeOf", () => {
  it.each([
    ["waits inside the window", landed, day(6), quiet, null],
    ["succeeds at day 7", landed, day(7), quiet, "success"],
    ["is flawed at once when its revert landed", landed, day(1), { ...quiet, revertLanded: true }, "flawed"],
    ["is flawed by a revert commit on base", landed, day(2), { ...quiet, revertOnBase: true }, "flawed"],
    ["is flawed by CI failing on base in its files", landed, day(3), { ...quiet, ciFailureOnBase: true }, "flawed"],
    ["flawed wins over manual", landed, day(8), { ...quiet, mergedOnHost: true, revertLanded: true }, "flawed"],
    ["is manual after the window when merged on the host", landed, day(7), { ...quiet, mergedOnHost: true }, "manual"],
    ["is manual with someone else's commits", landed, day(9), { ...quiet, foreignCommit: true }, "manual"],
    ["waits for manual until the window passes", landed, day(1), { ...quiet, foreignCommit: true }, null],
    ["is blocked when abandoned after its rounds ran out", { status: "abandoned", outcome: null, paused: pausedBy("fixRoundsExhausted") }, day(0), null, "blocked"],
    ["is blocked when abandoned after its session failed", { status: "abandoned", outcome: null, paused: pausedBy("sessionFailed") }, day(0), null, "blocked"],
    ["has none when a person abandoned it for another reason", { status: "abandoned", outcome: null, paused: pausedBy("manual") }, day(0), null, null],
    ["has none when abandoned without a pause", { status: "abandoned", outcome: null, paused: null }, day(0), null, null],
    ["never replaces an outcome", { ...landed, outcome: { state: "manual", decidedAt: landedAt, signals: [] } }, day(9), { ...quiet, revertLanded: true }, null],
    ["has none while the card is open", { status: "inReview", outcome: null, paused: null }, day(9), quiet, null],
  ] as const)("%s", (_name, card, now, signals, expected) => {
    const outcome = outcomeOf({ card: card as never, now, landed: signals });
    expect(outcome?.state ?? null).toBe(expected);
    if (outcome !== null) expect(outcome.decidedAt).toBe(now);
  });

  it("finds a full commit SHA in a failure's text", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(firstCommitSha(`CI run on ${sha} failed in src/a.ts`)).toBe(sha);
    expect(firstCommitSha("CI run on abc123 failed")).toBeNull();
  });
});
