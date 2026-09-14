import type { CardId, CardPriority, CardStatus, Reason, ThreadId } from "@iskra/contracts";

import type { HostAdmissionSnapshot } from "./HostAdmission.ts";
import { priorityRank } from "./HostAdmission.ts";

const MINUTE = 60_000;

/** The watchdog's limits (design B5). */
export const WATCHDOG_LIMITS = {
  stalledMs: 20 * MINUTE,
  hardStallMs: 45 * MINUTE,
  toolHungMs: 60 * MINUTE,
  awaitingInputMs: 10 * MINUTE,
  idleInProgressMs: 5 * MINUTE,
  repeatWindow: 10,
  repeatedActions: 4,
  errorLoop: 5,
  maxCardMs: 8 * 60 * MINUTE,
  budgetBreaker: 1.2,
  // A check may run 60 minutes; two more before its run counts as hung.
  checksHungMs: 62 * MINUTE,
  memoryPressureMs: MINUTE,
} as const;

export type WatchdogRule =
  | "stalled"
  | "hardStall"
  | "awaitingInput"
  | "repeatedAction"
  | "errorLoop"
  | "idleInProgress"
  | "wallClock"
  | "budgetBreaker";

/** What the watchdog knows about one live owner session. Times are epoch millis. */
export interface OwnerRunFacts {
  readonly threadId: ThreadId;
  readonly cardId: CardId;
  readonly cardStatus: CardStatus;
  readonly spentUsd: number;
  readonly budgetCapUsd: number;
  // A turn is running, including one waiting on a person.
  readonly turnActive: boolean;
  readonly awaitingInput: boolean;
  // When the session last changed state.
  readonly sessionSince: number;
  // The newest runtime activity on the thread, or the session change when there is none.
  readonly lastEventAt: number;
  readonly toolRunningSince: number | null;
  // Tool calls that finished, oldest first.
  readonly tools: ReadonlyArray<{
    readonly key: string;
    readonly failed: boolean;
    readonly at: number;
  }>;
  // When the card's first owner session started.
  readonly workStartedAt: number;
  // Nudges already given this session, and when the latest was.
  readonly strikes: ReadonlyMap<WatchdogRule, { readonly count: number; readonly at: number }>;
}

/**
 * What to do about a session: `nudge` records the problem and tells the agent; `stop` ends the
 * session so the scheduler restarts it from its brief; `pause` holds the card for a person,
 * stopping or interrupting the session first when it says so.
 */
export type WatchdogAction =
  | { readonly kind: "nudge"; readonly rule: WatchdogRule; readonly reason: Reason; readonly message: string }
  | { readonly kind: "stop"; readonly rule: WatchdogRule; readonly reason: Reason }
  | {
      readonly kind: "pause";
      readonly rule: WatchdogRule;
      readonly reason: Reason;
      readonly session: "stop" | "interrupt" | "keep";
    };

const minutes = (ms: number) => Math.round(ms / MINUTE);

/** The most repeated tool call among the latest window, and how often it ran. */
const mostRepeated = (tools: OwnerRunFacts["tools"]) => {
  const counts = new Map<string, number>();
  for (const tool of tools.slice(-WATCHDOG_LIMITS.repeatWindow)) {
    counts.set(tool.key, (counts.get(tool.key) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1])[0];
};

const trailingFailures = (tools: OwnerRunFacts["tools"]) => {
  let count = 0;
  for (const tool of tools.toReversed()) {
    if (!tool.failed) break;
    count += 1;
  }
  return count;
};

/**
 * The single most serious thing wrong with an owner session, or null. Rules follow design B5:
 * a hard limit pauses or stops; a softer one nudges first and pauses when it happens again after
 * the nudge. Only tool calls after the latest nudge count toward a second strike.
 */
export function watchOwnerRun(facts: OwnerRunFacts, now: number): WatchdogAction | null {
  const L = WATCHDOG_LIMITS;
  const strike = (rule: WatchdogRule) => facts.strikes.get(rule);

  if (facts.cardStatus === "inProgress" && now - facts.workStartedAt >= L.maxCardMs) {
    return {
      kind: "pause",
      rule: "wallClock",
      session: facts.turnActive ? "interrupt" : "keep",
      reason: {
        code: "wallClock",
        text: `The card has been in progress for ${Math.floor((now - facts.workStartedAt) / (60 * MINUTE))} hours; check on it, then resume.`,
      },
    };
  }
  if (facts.turnActive && facts.spentUsd >= facts.budgetCapUsd * L.budgetBreaker) {
    return {
      kind: "pause",
      rule: "budgetBreaker",
      session: "interrupt",
      reason: {
        code: "budgetBreaker",
        text: `The card spent $${facts.spentUsd.toFixed(2)}, past its $${facts.budgetCapUsd.toFixed(2)} budget; raise it, then resume.`,
      },
    };
  }
  if (facts.awaitingInput) {
    // ponytail: a question left unanswered pauses the card to free its slot; an elicitation-aware
    // scheduler could instead restart it once answered.
    return now - facts.sessionSince >= L.awaitingInputMs
      ? {
          kind: "pause",
          rule: "awaitingInput",
          session: "stop",
          reason: {
            code: "awaitingInput",
            text: "The agent waited over 10 minutes for an answer; answer it on the card, then resume.",
          },
        }
      : null;
  }
  if (facts.turnActive) {
    const silentFor = now - facts.lastEventAt;
    const toolFor = facts.toolRunningSince === null ? 0 : now - facts.toolRunningSince;
    if (silentFor >= L.hardStallMs && facts.toolRunningSince === null) {
      return {
        kind: "stop",
        rule: "hardStall",
        reason: { code: "stalled", text: `The agent's turn went ${minutes(silentFor)} minutes without activity; it was restarted.` },
      };
    }
    if (toolFor >= L.toolHungMs) {
      return {
        kind: "stop",
        rule: "hardStall",
        reason: { code: "stalled", text: `A tool call ran for ${minutes(toolFor)} minutes; the agent was restarted.` },
      };
    }
    if (silentFor >= L.stalledMs && facts.toolRunningSince === null && strike("stalled") === undefined) {
      return {
        kind: "nudge",
        rule: "stalled",
        reason: { code: "stalled", text: `The agent's turn has had no activity for ${minutes(silentFor)} minutes.` },
        message: "Your turn has gone quiet for a while. If you are stuck, say what is blocking you, or ask for help.",
      };
    }
  }

  for (const rule of ["repeatedAction", "errorLoop"] as const) {
    const previous = strike(rule);
    const tools = facts.tools.filter((tool) => previous === undefined || tool.at > previous.at);
    const repeated = mostRepeated(tools);
    const hit =
      rule === "repeatedAction"
        ? repeated !== undefined && repeated[1] >= L.repeatedActions
        : trailingFailures(tools) >= L.errorLoop;
    if (!hit) continue;
    const text =
      rule === "repeatedAction"
        ? `The agent ran the same tool call ${repeated?.[1]} times in its last ${L.repeatWindow}.`
        : `The agent's last ${trailingFailures(tools)} tool calls failed.`;
    return previous === undefined
      ? {
          kind: "nudge",
          rule,
          reason: { code: rule, text },
          message:
            rule === "repeatedAction"
              ? "You have run the same command several times without progress. Step back, try a different approach, or ask for help."
              : "Your recent tool calls keep failing. Read the errors, change approach, or ask for help.",
        }
      : { kind: "pause", rule, session: "stop", reason: { code: "stuck", text: `${text} It kept going after a nudge.` } };
  }

  if (!facts.turnActive && facts.cardStatus === "inProgress" && now - facts.sessionSince >= L.idleInProgressMs) {
    const previous = strike("idleInProgress");
    if (previous === undefined) {
      return {
        kind: "nudge",
        rule: "idleInProgress",
        reason: { code: "idleInProgress", text: "The agent stopped working while the card is in progress." },
        message:
          "The card is still in progress. Continue the work, ask for review when the acceptance criteria are met, or ask a question if you are blocked.",
      };
    }
    if (facts.sessionSince > previous.at) {
      return {
        kind: "pause",
        rule: "idleInProgress",
        session: "stop",
        reason: { code: "stuck", text: "The agent stopped again after being told the card is still in progress." },
      };
    }
  }
  return null;
}

/** Whether a card's check run has been running past every check's limit. */
export const checksHung = (
  checks: { readonly state: string; readonly updatedAt: number } | null,
  now: number,
): boolean =>
  checks !== null && checks.state === "running" && now - checks.updatedAt >= WATCHDOG_LIMITS.checksHungMs;

/**
 * Under memory pressure for a minute with heavy jobs running: cancel the lowest-priority heavy job,
 * and interrupt the lowest-priority owner turn (the newest among equals).
 */
export function memoryPressureActions(input: {
  readonly admission: HostAdmissionSnapshot;
  readonly activeOwners: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly priority: CardPriority;
    readonly startedAt: string;
  }>;
  readonly now: number;
}): { readonly cancelHeavyJob: boolean; readonly interrupt: ThreadId | null } {
  const since = input.admission.memoryPressureSince;
  if (since === null || input.now - since < WATCHDOG_LIMITS.memoryPressureMs) {
    return { cancelHeavyJob: false, interrupt: null };
  }
  const lowest = input.activeOwners.toSorted(
    (a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.startedAt.localeCompare(a.startedAt),
  )[0];
  return {
    cancelHeavyJob: input.admission.running.length > 0,
    interrupt: lowest?.threadId ?? null,
  };
}

export const MEMORY_PRESSURE_REASON: Reason = {
  code: "memoryPressure",
  text: "Paused: the machine is short on memory.",
};
