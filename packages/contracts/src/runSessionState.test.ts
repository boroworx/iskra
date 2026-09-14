import { describe, expect, it } from "vite-plus/test";

import { TurnId } from "./baseSchemas.ts";
import { ORPHANED_PROVIDER_SESSION_ERROR, runSessionState } from "./orchestration.ts";

const session = (
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error",
  overrides: { readonly activeTurnId?: string | null; readonly lastError?: string | null } = {},
) => ({
  status,
  activeTurnId:
    overrides.activeTurnId === undefined || overrides.activeTurnId === null
      ? null
      : TurnId.make(overrides.activeTurnId),
  lastError: overrides.lastError ?? null,
});

describe("runSessionState", () => {
  it("derives each state from the session a run's thread holds", () => {
    const live = { endedAt: null, awaitingInput: false };
    expect(runSessionState({ ...live, session: null })).toBe("pending");
    expect(runSessionState({ ...live, session: session("starting") })).toBe("pending");
    expect(runSessionState({ ...live, session: session("running", { activeTurnId: "turn-1" }) })).toBe(
      "active",
    );
    expect(
      runSessionState({
        ...live,
        awaitingInput: true,
        session: session("running", { activeTurnId: "turn-1" }),
      }),
    ).toBe("awaitingInput");
    expect(runSessionState({ ...live, session: session("ready") })).toBe("complete");
    expect(runSessionState({ ...live, session: session("interrupted") })).toBe("complete");
  });

  it("tells a failed session from one lost across a restart, and an ended one from both", () => {
    const ended = { endedAt: "2026-01-01T00:00:00.000Z", awaitingInput: false };
    expect(runSessionState({ ...ended, session: session("error", { lastError: "Turn failed." }) })).toBe(
      "error",
    );
    expect(
      runSessionState({
        ...ended,
        session: session("error", { lastError: ORPHANED_PROVIDER_SESSION_ERROR }),
      }),
    ).toBe("stale");
    expect(runSessionState({ ...ended, session: session("stopped") })).toBe("ended");
    expect(runSessionState({ ...ended, session: session("ready") })).toBe("ended");
  });
});
