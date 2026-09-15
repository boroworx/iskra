import {
  projectOrchestrationOf,
  projectSpendOf,
  type CardId,
  type CardPriority,
  type CardStatus,
  type OrchestrationAgent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type Reason,
  type ThreadId,
  type TurnId,
} from "@iskra/contracts";

import {
  agentBudgetReason,
  budgetWaitReason,
  environmentBudgetReason,
  environmentBudgetWaitReason,
  projectBudgetReason,
} from "./cardRules.ts";
import type { HeavyJobEntry, HostAdmissionSnapshot } from "./HostAdmission.ts";
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
  // A setup script is killed at 10 minutes; two more before its job counts as hung.
  setupHungMs: 12 * MINUTE,
  serviceDownMs: MINUTE,
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
    // An approval or a thread question left unanswered pauses the card; questions on the card free
    // the slot through the scheduler instead and restart once answered.
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

const HEAVY_JOB_NAMES: Record<HeavyJobEntry["job"]["kind"], string> = {
  checks: "The checks",
  runChecks: "A run_checks job",
  journey: "The journeys",
  holdout: "A hidden scenario",
  evidence: "The evidence capture",
  setup: "The setup script",
  landing: "The checks before landing",
};

/**
 * What to do about a heavy job running past its limit (setup 12 minutes, anything else 62): the
 * first time it is started again from scratch, after that it is stopped. `strikes` counts how often
 * this job was already started over for hanging.
 * ponytail: one limit per kind, not per job; a job running several long checks back to back can
 * outlast 62 minutes honestly. Give HeavyJob its own deadline if that happens.
 */
export function hungJobAction(
  entry: HeavyJobEntry,
  strikes: number,
  now: number,
): { readonly cancel: "requeue" | "stop"; readonly reason: Reason } | null {
  if (entry.startedAt === null) return null;
  const setup = entry.job.kind === "setup";
  const ranFor = now - entry.startedAt;
  if (ranFor < (setup ? WATCHDOG_LIMITS.setupHungMs : WATCHDOG_LIMITS.checksHungMs)) return null;
  const code = setup ? "setupTimedOut" : "checksHung";
  const name = HEAVY_JOB_NAMES[entry.job.kind];
  return strikes === 0
    ? {
        cancel: "requeue",
        reason: { code, text: `${name} ran ${minutes(ranFor)} minutes, past its limit; it was started again.` },
      }
    : {
        cancel: "stop",
        reason: { code, text: `${name} hung again after being started over; it was stopped.` },
      };
}

/** The reason code a service or preview the watchdog restarted is recorded with once it answers. */
export const SERVICE_RESTORED_CODE = "serviceRestored";

/** A card service's or preview's port as the watchdog probed it. */
export interface ServiceProbe {
  readonly kind: "service" | "preview";
  readonly name: string;
  readonly port: number;
  readonly up: boolean;
}

/**
 * Tracks when each probed port stopped listening. A port down for a minute is reported once per
 * outage, with the reason its card records (`serviceDown` or `previewDown`); a port that answers
 * again starts a new outage the next time it goes down.
 */
export function watchServices(input: {
  readonly probes: ReadonlyArray<ServiceProbe>;
  readonly outages: ReadonlyMap<string, { readonly since: number; readonly reported: boolean }>;
  readonly now: number;
}): {
  readonly outages: ReadonlyMap<string, { readonly since: number; readonly reported: boolean }>;
  readonly report: ReadonlyArray<ServiceProbe & { readonly reason: Reason }>;
} {
  const outages = new Map<string, { since: number; reported: boolean }>();
  const report: Array<ServiceProbe & { readonly reason: Reason }> = [];
  for (const probe of input.probes) {
    if (probe.up) continue;
    const key = `${probe.kind}:${probe.name}`;
    const outage = input.outages.get(key) ?? { since: input.now, reported: false };
    const due = !outage.reported && input.now - outage.since >= WATCHDOG_LIMITS.serviceDownMs;
    outages.set(key, { since: outage.since, reported: outage.reported || due });
    if (!due) continue;
    report.push({
      ...probe,
      reason:
        probe.kind === "service"
          ? {
              code: "serviceDown",
              text: `Service ${probe.name} stopped listening on port ${probe.port}; Iskra is restarting it.`,
            }
          : {
              code: "previewDown",
              text: `The preview stopped listening on port ${probe.port}; Iskra is restarting it.`,
            },
    });
  }
  return { outages, report };
}

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

/** What this machine's runs spent in the month of `now` (ISO), across every project. */
export const environmentSpendUsd = (projects: ReadonlyArray<OrchestrationProject>, now: string): number =>
  projects.reduce((total, project) => total + projectSpendOf(project, now).totalUsd, 0);

/**
 * Why a monthly budget holds `agent`'s next turn in `project` (at 100%), or null: the project's
 * cap, then the agent's, then this machine's.
 */
export const budgetHold = (input: {
  readonly project: OrchestrationProject;
  readonly agent: Pick<OrchestrationAgent, "id" | "name"> | null;
  readonly environmentBudgetUsd: number | null;
  readonly environmentSpentUsd: number;
  readonly now: string;
}): Reason | null =>
  budgetWaitReason(projectOrchestrationOf(input.project), projectSpendOf(input.project, input.now), input.agent) ??
  environmentBudgetWaitReason(input.environmentBudgetUsd, input.environmentSpentUsd);

/** A running turn past 120% of a monthly budget: interrupt it, and pause its card if it has one. */
export interface BudgetBreach {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly cardId: CardId | null;
  readonly reason: Reason;
}

/**
 * Every running turn, card or conversation, whose project, agent or machine spent past
 * `WATCHDOG_LIMITS.budgetBreaker` times its monthly cap. Between 100% and that, turns finish and
 * new ones wait instead.
 */
export function budgetBreaches(input: {
  readonly readModel: Pick<OrchestrationReadModel, "projects" | "threads" | "agents" | "channels" | "cards" | "liveRuns">;
  readonly environmentBudgetUsd: number | null;
  readonly now: string;
}): ReadonlyArray<BudgetBreach> {
  const { readModel, now } = input;
  const factor = WATCHDOG_LIMITS.budgetBreaker;
  const turns = new Map(readModel.threads.map((thread) => [thread.id, thread.session?.activeTurnId ?? null] as const));
  const projects = new Map(readModel.projects.map((project) => [project.id, project] as const));
  const projectOfChannel = new Map((readModel.channels ?? []).map((channel) => [channel.id, channel.projectId] as const));
  const projectOfCard = new Map((readModel.cards ?? []).map((card) => [card.id, card.projectId] as const));
  const agents = new Map((readModel.agents ?? []).map((agent) => [agent.id, agent] as const));
  const environmentSpent = environmentSpendUsd(readModel.projects, now);

  const breachReason = (project: OrchestrationProject, agentId: OrchestrationAgent["id"]): string | null => {
    const { projectUsd, perAgentUsd } = projectOrchestrationOf(project).budgets;
    const spend = projectSpendOf(project, now);
    if (projectUsd !== null && spend.totalUsd >= projectUsd * factor) return projectBudgetReason(projectUsd);
    const agentUsd = spend.byAgent.find((entry) => entry.agentId === agentId)?.usd ?? 0;
    const agent = agents.get(agentId);
    if (agent !== undefined && perAgentUsd !== null && agentUsd >= perAgentUsd * factor) {
      return agentBudgetReason(agent.name, perAgentUsd);
    }
    const machineUsd = input.environmentBudgetUsd;
    return machineUsd !== null && environmentSpent >= machineUsd * factor ? environmentBudgetReason(machineUsd) : null;
  };

  return (readModel.liveRuns ?? []).flatMap((run) => {
    const turnId = turns.get(run.threadId) ?? null;
    const projectId =
      run.cardId !== null ? projectOfCard.get(run.cardId) : run.channelId !== null ? projectOfChannel.get(run.channelId) : undefined;
    const project = projectId === undefined ? undefined : projects.get(projectId);
    if (turnId === null || project === undefined) return [];
    const text = breachReason(project, run.agentId);
    return text === null
      ? []
      : [{ threadId: run.threadId, turnId, cardId: run.cardId, reason: { code: "budgetBreaker", text } }];
  });
}
