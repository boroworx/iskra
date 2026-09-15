import {
  CARD_AUTOFIX_ATTEMPTS,
  delegateReadOnlyText,
  projectOrchestrationOf,
  type OrchestrationAgentShell,
  type CardActivity,
  type CardId,
  type CardRelationKind,
  type CardStatus,
  type Elicitation,
  type ElicitationKind,
  type OrchestrationCard,
  type OrchestrationCardShell,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProjectOrchestration,
  type ProjectTrigger,
  type Reason,
  type RunSessionState,
  type CardPriority,
} from "@iskra/contracts";

/** The board's columns, left to right. Landed and abandoned cards share Done. */
export const BOARD_COLUMNS = [
  "triage",
  "ready",
  "inProgress",
  "inReview",
  "landing",
  "done",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABEL: Record<BoardColumn, string> = {
  triage: "Triage",
  ready: "Ready",
  inProgress: "In progress",
  inReview: "Review",
  landing: "Landing",
  done: "Done",
};

export function boardColumnOf(status: CardStatus): BoardColumn {
  return status === "landed" || status === "abandoned" ? "done" : status;
}

const isOpenStatus = (status: CardStatus) => status !== "landed" && status !== "abandoned";

/** The human decision a drag stands for; everything else moves on its own. */
type CardDecisionCommand =
  | "card.approve"
  | "card.unapprove"
  | "card.merge.approve"
  | "card.merge.cancel"
  | "card.abandon"
  | "card.reopen";

type CardDropDecision =
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly type: CardDecisionCommand }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * What dropping a card in a column means. Only human decisions move a card by
 * hand; a drop anywhere else snaps back with the reason. The server can still
 * refuse a decision (an open sub-card, a blocker) and its reason is shown then.
 */
export function cardDropDecision(
  status: CardStatus,
  to: BoardColumn,
  /** Why the merge can't be approved yet, such as a verifier that hasn't passed. */
  mergeRefusal: string | null = null,
): CardDropDecision {
  if (boardColumnOf(status) === to) {
    return { kind: "none" };
  }
  if (status === "landed") {
    return { kind: "refuse", reason: "A landed card is finished." };
  }
  if (status === "abandoned") {
    return to === "triage"
      ? { kind: "command", type: "card.reopen" }
      : { kind: "refuse", reason: "Reopen an abandoned card by dropping it on Triage." };
  }
  switch (to) {
    case "done":
      return { kind: "command", type: "card.abandon" };
    case "ready":
      return status === "triage"
        ? { kind: "command", type: "card.approve" }
        : { kind: "refuse", reason: "Only a card in triage can be approved." };
    case "triage":
      return status === "ready"
        ? { kind: "command", type: "card.unapprove" }
        : {
            kind: "refuse",
            reason: "Only a ready card whose work has not started can go back to triage.",
          };
    case "landing":
      return status !== "inReview"
        ? { kind: "refuse", reason: "Only a card in review can be approved to merge." }
        : mergeRefusal !== null
          ? { kind: "refuse", reason: mergeRefusal }
          : { kind: "command", type: "card.merge.approve" };
    case "inReview":
      return status === "landing"
        ? { kind: "command", type: "card.merge.cancel" }
        : { kind: "refuse", reason: "The card's agent sends it to review when the work is done." };
    case "inProgress":
      return {
        kind: "refuse",
        reason:
          "Work starts when the card's agent starts its first session; assign an agent instead.",
      };
  }
}

const CARD_DECISION_LABEL: Record<CardDecisionCommand, string> = {
  "card.approve": "Approve",
  "card.unapprove": "Back to triage",
  "card.merge.approve": "Approve merge",
  "card.merge.cancel": "Cancel merge",
  "card.abandon": "Abandon",
  "card.reopen": "Reopen",
};

interface CardMoveAction {
  readonly column: BoardColumn;
  readonly label: string;
  /** The decision to send, or null when the move happens on its own and `reason` says why. */
  readonly type: CardDecisionCommand | null;
  readonly reason: string | null;
}

/** A card's move buttons, from the same rules as a drop so a button and a drag never disagree. */
export function cardMoveActions(
  status: CardStatus,
  mergeRefusal: string | null = null,
): ReadonlyArray<CardMoveAction> {
  if (status === "landed") {
    return [];
  }
  return BOARD_COLUMNS.flatMap((column): CardMoveAction[] => {
    const decision = cardDropDecision(status, column, mergeRefusal);
    // A merge held back by its verifier keeps its label, disabled with the reason.
    if (decision.kind === "refuse" && column === "landing" && status === "inReview") {
      return [
        {
          column,
          label: CARD_DECISION_LABEL["card.merge.approve"],
          type: null,
          reason: decision.reason,
        },
      ];
    }
    if (decision.kind === "none") {
      return [];
    }
    return decision.kind === "command"
      ? [{ column, label: CARD_DECISION_LABEL[decision.type], type: decision.type, reason: null }]
      : [
          {
            column,
            label: `Move to ${BOARD_COLUMN_LABEL[column]}`,
            type: null,
            reason: decision.reason,
          },
        ];
  });
}

/** A card session's state in words, for the board, the card sheet and attempts. */
export const CARD_SESSION_LABEL: Record<RunSessionState, string> = {
  pending: "Starting",
  active: "Working",
  awaitingInput: "Waiting for you",
  complete: "Idle",
  error: "Failed",
  stale: "Stale",
  ended: "Stopped",
};

const CARD_SESSION_HINT: Partial<Record<RunSessionState, string>> = {
  pending: "Its agent's session is starting.",
  active: "Its agent is working on it.",
  awaitingInput: "Its agent asked you something; reply from the card.",
  complete: "Its agent finished its turn and waits for a message or review.",
  error: "Its session failed. Open the agent to see why.",
  stale: "Its session was lost in a restart before it finished.",
};

/** What an evidence item that couldn't be captured says when no desktop app took the screenshot. */
export const NO_PREVIEW_HOST_TEXT = "No desktop client was connected to capture the preview";

interface ReasonLabel {
  readonly label: string;
  readonly hint: string;
}

/**
 * Short words and a tooltip for every reason code Iskra emits: why a card waits, why it paused,
 * what an error or an activity is, why evidence wasn't captured. Board badges, Needs you and the
 * card sheet all read this one table; a code it doesn't know reads as the server's own text.
 */
export const REASON_LABEL: Readonly<Record<string, ReasonLabel>> = {
  // Waits: the card could run but Iskra holds it.
  waitingForCapacity: {
    label: "Waiting for machine capacity",
    hint: "The machine is busy with other heavy jobs; it starts when load drops.",
  },
  waitingForSlot: {
    label: "Waiting for a session slot",
    hint: "Every agent session slot is taken; it starts when one frees.",
  },
  waitingForMemory: {
    label: "Waiting for free memory",
    hint: "The machine is short on memory; it starts when some frees.",
  },
  reviewCapacity: {
    label: "Waiting for agent pull requests to be reviewed",
    hint: "The project has as many open agent pull requests as it allows; review or land one.",
  },
  blocked: { label: "Waiting on a blocker", hint: "A card it is blocked by has not landed." },
  criteriaNotConfirmed: {
    label: "Criteria not confirmed",
    hint: "Work starts once a person confirms the acceptance criteria.",
  },
  sideEffectGuard: {
    label: "Waiting for the side-effect guard",
    hint: "Someone must review this project's side-effect guard in project settings first.",
  },
  delegateReadOnly: {
    label: "Its agent can only read",
    hint: "A card's agent needs write access to change files. Give it write access in its agent settings.",
  },
  // Pauses: the card is held until a person resumes it.
  startFailed: {
    label: "Couldn't start",
    hint: "Its agent session failed to start; Iskra retries, then pauses it.",
  },
  sessionFailed: {
    label: "Session failed",
    hint: "Its agent session stopped without finishing.",
  },
  stuck: { label: "Stuck", hint: "The watchdog saw no progress and paused it." },
  awaitingInput: {
    label: "Waiting on your answer",
    hint: "Its agent asked something and nobody answered in time.",
  },
  wallClock: {
    label: "Ran too long",
    hint: "It passed the longest a card may run without a person looking.",
  },
  budgetBreaker: {
    label: "Over budget",
    hint: "It spent well past its cap, so its turn was interrupted.",
  },
  fixRoundsExhausted: {
    label: "Fix rounds used up",
    hint: "Checks or review sent it back as many times as the project allows; give it more rounds or take over.",
  },
  checkpointStopped: {
    label: "Stopped at a checkpoint",
    hint: "A person stopped it at its checkpoint.",
  },
  pausedByPerson: { label: "Paused by you", hint: "A person paused it." },
  refMovedOutsideCard: {
    label: "Refs changed outside this card",
    hint: "Branches or tags other than the card's own changed during an agent turn. If the agent did this, restore them; if you did, keep them.",
  },
  // Errors the watchdog records.
  stalled: { label: "Stalled", hint: "Its agent's turn stopped making progress." },
  repeatedAction: {
    label: "Repeating itself",
    hint: "Its agent ran the same action over and over.",
  },
  errorLoop: { label: "Error loop", hint: "Its agent kept hitting the same error." },
  idleInProgress: {
    label: "Idle while in progress",
    hint: "Its agent ended its turn without finishing or asking for review.",
  },
  checksHung: {
    label: "Checks hung",
    hint: "Its checks ran past every check's time limit and were stopped.",
  },
  memoryPressure: {
    label: "Paused for memory",
    hint: "The machine ran short on memory, so its turn was interrupted; it picks up from its worklog.",
  },
  // Evidence that couldn't be captured.
  noPreviewHost: {
    label: NO_PREVIEW_HOST_TEXT,
    hint: "Screenshots need a connected desktop app. Look at the change yourself.",
  },
  noRunScript: {
    label: "No run script to preview",
    hint: "The project has no run script, so there was no preview to capture.",
  },
  previewFailed: { label: "The preview failed", hint: "The preview didn't load to capture." },
  previewUrlRefused: {
    label: "Preview address refused",
    hint: "The preview's address isn't one Iskra captures.",
  },
  pendingCi: {
    label: "Waiting for CI",
    hint: "CI hasn't reported on the pull request yet; the merge waits for it.",
  },
  // Things on a card that wait for a person.
  checksMissing: {
    label: "No checks",
    hint: "The project has no checks, so the card can't enter review. Add one or waive checks.",
  },
  untrustedComment: {
    label: "Comment from outside the repository",
    hint: "Its author can't direct work here; forward it to the agent if it should count.",
  },
  landingBlocked: { label: "Landing blocked", hint: "The merge was refused." },
  pullRequestOpenFailed: {
    label: "Pull request didn't open",
    hint: "Iskra couldn't open the card's pull request.",
  },
  pullRequestClosed: {
    label: "Pull request closed",
    hint: "The pull request was closed without merging.",
  },
  pullRequestReopened: {
    label: "Pull request reopened",
    hint: "The closed pull request is open again, so nothing waits on you for it.",
  },
  criteriaMissing: {
    label: "No acceptance criteria",
    hint: "The issue lists no acceptance criteria; add some on the card.",
  },
  ciChecksNeedPullRequest: {
    label: "CI checks need a pull request",
    hint: "Every check runs in CI, but this card can't open a pull request. Add a local check or a remote.",
  },
  // What Iskra told the card's agent.
  checksFailed: { label: "Checks failed", hint: "Its agent got the failing output." },
  ciFailed: { label: "CI failed", hint: "Its agent got the failing CI checks." },
  rebaseConflict: {
    label: "Rebase conflict",
    hint: "Rebasing onto the base branch conflicts; its agent resolves it.",
  },
  reviewRefused: {
    label: "Review refused",
    hint: "The card couldn't enter review; its agent was told why.",
  },
  reviewComment: {
    label: "Review comment",
    hint: "A trusted comment on the pull request, sent to its agent.",
  },
  exclusivePathChanged: {
    label: "Shared files changed",
    hint: "Another card landed changes to files only one card may change at a time; its agent rebases.",
  },
  overlap: { label: "Overlaps another card", hint: "Another open card changes the same files." },
  noWorktree: { label: "No worktree", hint: "The card's worktree is missing." },
  reviewRequested: {
    label: "Asked for review",
    hint: "Its agent says the work is done; Iskra captures evidence before review.",
  },
  runChecksRequested: {
    label: "Checks queued",
    hint: "Its agent asked to run the project's checks; they run when the machine has room.",
  },
  runChecksResult: { label: "Checks ran", hint: "The result went to its agent." },
  evidenceCaptureRequested: {
    label: "Evidence requested",
    hint: "A person asked Iskra to capture evidence for the card's current commit.",
  },
  mergedOnHost: {
    label: "Merged on the host",
    hint: "A person merged its pull request on the host, which counts as approving it.",
  },
  // The verifier: why this one checks the card, and what came of it.
  differentProvider: {
    label: "Different provider",
    hint: "The verifier runs on another provider than the builder, so it doesn't share its blind spots.",
  },
  sameProviderVerifier: {
    label: "Another model",
    hint: "No other provider could verify here, so a different model on the builder's provider checks it.",
  },
  sameModelVerifier: {
    label: "Same model, fresh session",
    hint: "No other provider or model could verify here, so the builder's own model checks it from scratch.",
  },
  verifierFailed: {
    label: "The verifier didn't pass this commit",
    hint: "Its agent got the notes on any failed criteria and a count of failed hidden scenarios, and fixes them.",
  },
  verifierError: {
    label: "The verifier didn't finish",
    hint: "The verifier's session failed, even after a retry. Rerun it, or override it with a reason.",
  },
  verdictStale: {
    label: "Verdict for an older commit",
    hint: "The card changed after the verdict; the verifier checks the latest commit.",
  },
  verifierOverridden: {
    label: "Verifier overridden",
    hint: "A person let the card past its verifier and said why.",
  },
  // Runtime: journeys, services and setup.
  journeyFailed: {
    label: "Journey failed",
    hint: "A user journey failed against the card's running services; its agent got the output.",
  },
  serviceDown: {
    label: "Service down",
    hint: "One of the card's services stopped answering on its port.",
  },
  previewDown: {
    label: "Preview down",
    hint: "The card's preview stopped answering on its port.",
  },
  setupTimedOut: {
    label: "Setup timed out",
    hint: "The card's setup script ran past its time limit.",
  },
  reactorFailed: {
    label: "Iskra hit an error",
    hint: "One of Iskra's steps failed on this card; its activity says which.",
  },
  exclusivePathBusy: {
    label: "Waiting for shared files",
    hint: "Another card is changing files only one card may change at a time; this one starts after it lands.",
  },
  previewHostConnected: {
    label: "Screenshots captured",
    hint: "A desktop app connected, so Iskra captured the screenshots review was missing.",
  },
  // Plans, budgets, outcomes and reverts.
  coordinatorPaused: {
    label: "Paused by its plan's coordinator",
    hint: "The coordinator paused this child; its activity says why. Resume it when you agree.",
  },
  heldByCheckpoint: {
    label: "Held for slice checkpoint",
    hint: "It starts once you continue at the plan's checkpoint after the earlier slice lands.",
  },
  budgetCap: {
    label: "Budget reached",
    hint: "The project spent its monthly budget. Raise it in project settings to start more work.",
  },
  agentBudgetCap: {
    label: "Agent budget reached",
    hint: "Its agent spent its monthly budget in this project. Raise it in project settings.",
  },
  environmentBudgetCap: {
    label: "Machine budget reached",
    hint: "This machine spent its monthly budget across projects. Raise it in settings.",
  },
  revertConflict: {
    label: "Revert conflicts",
    hint: "The revert didn't apply cleanly. Assign an agent to resolve it, or dismiss it.",
  },
  outcomeFlawed: {
    label: "Turned out flawed",
    hint: "It landed, then was reverted or broke CI. Add a hidden scenario so it doesn't happen again.",
  },
  outcomeSetByPerson: {
    label: "Outcome set by you",
    hint: "A person set how this card turned out and said why.",
  },
  triggerRefused: {
    label: "Trigger refused",
    hint: "The trigger fired but made no card; the reason says why.",
  },
};

const BUDGET_WAIT_CODES: ReadonlySet<string> = new Set([
  "budgetCap",
  "agentBudgetCap",
  "environmentBudgetCap",
]);

/** The server's refusals a person can see coming, so buttons say them before trying. */
export const REVERT_NOT_LANDED_TEXT = "Only a landed card can be reverted.";
export const REVERT_IN_PROGRESS_TEXT = "This card already has a revert in progress.";
export const RESTORE_NEEDS_STOPPED_TEXT =
  "Restore needs the card's agent stopped; pause the card first.";
export const AUTO_MERGE_NEEDS_VERIFIER_TEXT =
  "Turn on the verifier before auto-merge; it merges only verified work.";
export const TRIGGER_WORK_WAITS_TEXT =
  "Work started by a trigger always waits for a person to merge.";

/** Why a card can't be reverted now, or null (mirrors the decider). */
export function revertRefusal(
  card: Pick<OrchestrationCard, "id" | "status">,
  cards: ReadonlyArray<Pick<OrchestrationCard, "revertsCardId" | "status">>,
): string | null {
  if (card.status !== "landed") return REVERT_NOT_LANDED_TEXT;
  return cards.some((other) => other.revertsCardId === card.id && isOpenStatus(other.status))
    ? REVERT_IN_PROGRESS_TEXT
    : null;
}

/** Why a card's worktree can't be restored now, or null: its agent must be stopped by a pause. */
export function restoreRefusal(
  card: Pick<OrchestrationCardShell, "status" | "paused" | "ownerSession">,
): string | null {
  return isOpenStatus(card.status) &&
    card.paused !== null &&
    card.ownerSession?.state !== "active" &&
    card.ownerSession?.state !== "pending"
    ? null
    : RESTORE_NEEDS_STOPPED_TEXT;
}

/** Why a trigger can't be saved as set, or null (mirrors the decider's policy check). */
export function triggerConfigRefusal(
  trigger: Pick<ProjectTrigger, "id" | "kind" | "intake" | "template">,
): string | null {
  return trigger.intake === "ready" &&
    (trigger.kind !== "schedule" || trigger.template.criteria.length === 0)
    ? `Trigger '${trigger.id}' can't start ready work: only schedule triggers with fixed criteria can.`
    : null;
}

/** The approve-merge refusal while a required verifier hasn't passed, in the server's words. */
export const VERIFIER_NOT_PASSED_TEXT = "The verifier hasn't passed every criterion yet.";
export const OVERRIDE_REASON_REQUIRED_TEXT = "Say why you're overriding the verifier.";
const OVERRIDE_STATE_TEXT = "Only a failed or pending verification can be overridden.";
const VERIFY_IN_REVIEW_TEXT = "Only a card in review is verified.";

type VerificationFacts = Pick<OrchestrationCard, "status" | "verification" | "evidence">;

/**
 * Whether a card needs a passing verifier, as the server decides it: its project turned the
 * verifier on, its builder's template always verifies, or a verification already started.
 */
export function cardVerificationRequired(
  card: Pick<OrchestrationCard, "verification">,
  policy: Pick<ProjectOrchestration, "verifier">,
  builder: Pick<OrchestrationAgentShell, "blueprint"> | undefined,
): boolean {
  return (
    policy.verifier.mode === "on" ||
    builder?.blueprint?.verify === "always" ||
    card.verification.state !== "off"
  );
}

/** Why a person can't approve the merge for its verifier yet, or null (mirrors the decider). */
export function verifierMergeRefusal(
  card: Pick<OrchestrationCard, "verification" | "evidence">,
  required: boolean,
): string | null {
  if (!required || card.verification.state === "overridden") return null;
  return card.verification.state === "passed" &&
    card.verification.headSha === (card.evidence?.headSha ?? null)
    ? null
    : VERIFIER_NOT_PASSED_TEXT;
}

/** Why the verifier can't be overridden now (a reason is checked apart, as the form types it). */
export function overrideVerifierRefusal(card: VerificationFacts, required: boolean): string | null {
  const state = card.verification.state === "off" && required ? "pending" : card.verification.state;
  return state === "failed" || state === "pending" ? null : OVERRIDE_STATE_TEXT;
}

/**
 * Why the verifier can't be rerun now, or null. A "running" verification can be rerun: only the
 * server sees whether its verifier run is still live, and refuses when it is.
 */
export function rerunVerifierRefusal(card: VerificationFacts): string | null {
  return card.status === "inReview" ? null : VERIFY_IN_REVIEW_TEXT;
}

/**
 * The warning a card's start shows when the chosen agent can't write, in the scheduler's words;
 * null when it can, or when an older server doesn't say.
 */
export function delegateReadOnlyWarning(
  agent: Pick<OrchestrationAgentShell, "name" | "capabilities"> | null,
): string | null {
  return agent?.capabilities === undefined || agent.capabilities.includes("write")
    ? null
    : delegateReadOnlyText(agent.name);
}

/** A reason's short words and tooltip; an unknown code reads as its own text. */
export function reasonLabel(reason: Pick<Reason, "code" | "text">): ReasonLabel {
  return Object.hasOwn(REASON_LABEL, reason.code)
    ? REASON_LABEL[reason.code]!
    : { label: reason.text, hint: reason.text };
}

/** A reason as one line: its label, and the server's text when that says more. */
export function reasonLine(reason: Pick<Reason, "code" | "text">): string {
  const { label } = reasonLabel(reason);
  return label === reason.text ? label : `${label}: ${reason.text}`;
}

interface CardBadge {
  readonly label: string;
  /** A short tooltip saying what the badge means. */
  readonly hint: string;
  readonly alarming: boolean;
}

/** The badges on a card's face, each with what it means. */
export function cardBadges(
  card: OrchestrationCardShell,
  facts: { readonly blocked: boolean; readonly snoozed: boolean },
): ReadonlyArray<CardBadge> {
  const badges: CardBadge[] = [];
  const open = isOpenStatus(card.status);
  if (card.specState === "draft" && card.status !== "triage" && open) {
    badges.push({
      label: "Spec draft",
      hint: "The spec is not approved yet. Approve or skip it on the card.",
      alarming: false,
    });
  }
  // Only unfinished cards: a landed or abandoned card has nothing left to hold to criteria.
  if (open && card.status !== "triage" && card.acceptance.state === "draft") {
    badges.push({
      label: "Criteria not confirmed",
      hint: "Work starts only once a person confirms the acceptance criteria on the card.",
      alarming: false,
    });
  } else if (open && card.acceptance.criteria.length === 0) {
    badges.push({
      label: "No acceptance criteria",
      hint: "Review has no criteria to hold the work to. Add some on the card.",
      alarming: false,
    });
  }
  if (facts.blocked) {
    badges.push({
      label: "Blocked",
      hint: "It waits on a card it is blocked by that has not landed.",
      alarming: true,
    });
  }
  if (open && card.paused !== null) {
    const known = Object.hasOwn(REASON_LABEL, card.paused.reason.code);
    badges.push({
      label:
        known && card.paused.by === "system" ? reasonLabel(card.paused.reason).label : "Paused",
      hint: `${card.paused.reason.text} Resume it from the card.`,
      alarming: card.paused.by === "system",
    });
  } else if (open && card.waitReason !== null) {
    const { label, hint } = reasonLabel(card.waitReason);
    badges.push({
      label,
      hint: label === card.waitReason.text ? hint : card.waitReason.text,
      alarming: false,
    });
  }
  if (open && card.unattended) {
    badges.push({
      label: "Draft PR",
      hint: "A trigger started it with nobody approving, so its pull request opens as a draft and a person merges it.",
      alarming: false,
    });
  }
  if (facts.snoozed) {
    badges.push({
      label: "Snoozed",
      hint: "Hidden from Needs you until its time or its next activity.",
      alarming: false,
    });
  }
  const session = card.ownerSession;
  const sessionHint = session === null ? undefined : CARD_SESSION_HINT[session.state];
  if (session !== null && sessionHint !== undefined) {
    badges.push({
      label: CARD_SESSION_LABEL[session.state],
      hint: sessionHint,
      alarming: session.state === "awaitingInput" || session.state === "error",
    });
  }
  if (open && card.checkpoint !== null) {
    badges.push({
      label: "Checkpoint",
      hint: "Its agent wants you to look at its work so far before it goes on.",
      alarming: true,
    });
  }
  if (open && card.evidence !== null) {
    badges.push(...evidenceBadges(card.evidence));
  } else if (card.checks !== null && card.status === "inReview") {
    // Cards reviewed before evidence still carry the old checks summary.
    badges.push(
      card.checks.state === "running"
        ? {
            label: "Checks running",
            hint: "The project checks run on its branch.",
            alarming: false,
          }
        : card.checks.state === "passed"
          ? {
              label: "Checks passed",
              hint: "The project checks passed; approve the merge.",
              alarming: false,
            }
          : {
              label: `Checks failed ${card.checks.failedRuns}/${CARD_AUTOFIX_ATTEMPTS}`,
              hint: `Checks failed ${card.checks.failedRuns} times in a row. Its agent retries up to ${CARD_AUTOFIX_ATTEMPTS} times, then waits for you.`,
              alarming: true,
            },
    );
  }
  if (open && card.spentUsd >= card.budgetCapUsd) {
    badges.push({
      label: "Budget reached",
      hint: "It spent its cap. Raise the budget on the card to continue.",
      alarming: true,
    });
  } else if (open && card.unpricedTurns > 0 && !card.acceptsUnpriced) {
    badges.push({
      label: "Unpriced model",
      hint: "Its model has no known price, so its spend can't be capped. Run it uncapped to continue.",
      alarming: true,
    });
  }
  return badges;
}

function evidenceBadges(evidence: NonNullable<OrchestrationCard["evidence"]>): CardBadge[] {
  const badges: CardBadge[] = [];
  if (!evidence.passed) {
    badges.push({
      label: "Evidence failed",
      hint:
        evidence.failedChecks.length > 0
          ? `Failed: ${evidence.failedChecks.join(", ")}. Its agent gets the output.`
          : "Its latest evidence did not pass.",
      alarming: true,
    });
  } else if (hasUnacknowledgedHardFlags(evidence)) {
    badges.push({
      label: "Flags to acknowledge",
      hint: "Deleted tests or protected files changed. Acknowledge them on the card before merging.",
      alarming: true,
    });
  } else {
    badges.push({
      label: evidence.purpose === "checkpoint" ? "Checkpoint evidence" : "Evidence passed",
      hint: `${evidence.checkCount} check${evidence.checkCount === 1 ? "" : "s"} passed on its latest commit.`,
      alarming: false,
    });
  }
  const pendingCi = evidence.pendingCi ?? [];
  if (pendingCi.length > 0) {
    badges.push({
      label: REASON_LABEL.pendingCi!.label,
      hint: `No result yet from ${pendingCi.join(", ")}. The merge waits for CI.`,
      alarming: false,
    });
  }
  if (evidence.unavailable.length > 0) {
    badges.push({
      label: "No preview capture",
      hint: `${NO_PREVIEW_HOST_TEXT}. Look at the change yourself before merging.`,
      alarming: false,
    });
  }
  return badges;
}

export function hasUnacknowledgedHardFlags(
  evidence: Pick<NonNullable<OrchestrationCard["evidence"]>, "flags" | "flagsAcknowledgedAt">,
): boolean {
  return evidence.flagsAcknowledgedAt === null && evidence.flags.some((flag) => flag.hard);
}

export const CARD_RELATION_LABEL: Record<CardRelationKind, string> = {
  blocks: "Blocks",
  blockedBy: "Blocked by",
  duplicateOf: "Duplicate of",
  related: "Related to",
  overlaps: "Overlaps",
};

type SnoozeFacts = Pick<OrchestrationCard, "snoozedUntil" | "snoozedAt" | "activityAt">;

/** Snoozed until its time passes or the card has new activity, whichever comes first. */
export function isCardSnoozed(card: SnoozeFacts, now: number): boolean {
  if (card.snoozedAt === null || Date.parse(card.activityAt) > Date.parse(card.snoozedAt)) {
    return false;
  }
  return card.snoozedUntil === null || Date.parse(card.snoozedUntil) > now;
}

/** A card session's standing, as the Needs you list reads it. */
interface CardSessionSummary {
  readonly cardId: CardId;
  readonly state: RunSessionState;
  /** When the session reached this state. */
  readonly since: string;
}

/** The standing of each card's owner session, for cards that have one. */
export function cardOwnerSessions(
  cards: ReadonlyArray<Pick<OrchestrationCardShell, "id" | "ownerSession">>,
): ReadonlyArray<CardSessionSummary> {
  return cards.flatMap((card) =>
    card.ownerSession === null
      ? []
      : [{ cardId: card.id, state: card.ownerSession.state, since: card.ownerSession.since }],
  );
}

export type NeedsYouKind =
  | "triage"
  | "spec"
  | "criteria"
  | "needsAgent"
  | "delegateReadOnly"
  | "awaitingInput"
  | "criteriaChange"
  | "checkpoint"
  | "sessionFailed"
  | "paused"
  | "fixRoundsExhausted"
  | "sideEffectGuard"
  | "evidenceMissing"
  | "scopeFlags"
  | "readyToMerge"
  | "budgetReached"
  | "unpricedModel"
  | "attention"
  | "refsChanged"
  | "planApproval"
  | "sliceCheckpoint"
  | "lessonProposed"
  | "outcomeFlawed"
  | "revertConflict"
  | "budgetCap";

/** Linear's priority names, most urgent first, then none. */
export const CARD_PRIORITIES: ReadonlyArray<CardPriority> = [1, 2, 3, 4, 0];
export const CARD_PRIORITY_LABEL: Record<CardPriority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

interface NeedsYouItem {
  readonly key: string;
  readonly kind: NeedsYouKind;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** When the item started waiting on a person. */
  readonly since: string;
  /** Why it waits, in the words Iskra or the agent gave; null when the label says it all. */
  readonly reason: string | null;
  /** The reason code behind a pause or attention item, which names it more exactly than its kind. */
  readonly code: string | null;
  /** The question or attention item it is answered on; null when it isn't one. */
  readonly activityId: string | null;
  /** The proposed lesson it decides; null unless it is a lessonProposed item. */
  readonly lessonId: string | null;
  /** A session waiting on an answer is never snoozed away. */
  readonly snoozable: boolean;
}

export const NEEDS_YOU_LABEL: Record<NeedsYouKind, string> = {
  triage: "Approve or drop this proposal",
  spec: "Approve or skip the spec",
  criteria: "Confirm the acceptance criteria",
  needsAgent: "Assign an agent to start",
  delegateReadOnly: "Its agent can only read; give it write access",
  awaitingInput: "Its agent is waiting on you",
  criteriaChange: "Its agent proposes a change to the acceptance criteria",
  checkpoint: "Its agent wants you to check its work before going on",
  sessionFailed: "Its session stopped without finishing",
  paused: "Iskra paused it",
  fixRoundsExhausted: "Its fix rounds are used up; give it more or take over",
  sideEffectGuard: "Review this project's side-effect guard before agents start",
  evidenceMissing: "Some evidence couldn't be captured; check it yourself",
  scopeFlags: "Acknowledge the flagged changes before merging",
  readyToMerge: "Evidence passed; approve the merge",
  budgetReached: "It reached its budget; raise the cap to continue",
  unpricedModel: "Its model has no known price; accept running it uncapped",
  attention: "Something on it waits on you",
  refsChanged: "Refs changed outside this card; restore or keep them",
  planApproval: "Plan to approve",
  sliceCheckpoint: "A plan slice landed; continue?",
  lessonProposed: "An agent proposed a lesson about the project",
  outcomeFlawed: "It turned out flawed; add a hidden scenario",
  revertConflict: "Its revert conflicts; assign an agent",
  budgetCap: "A monthly budget holds its work; raise it to continue",
};

/** A Needs you item's label: its pause's own name when Iskra knows the code, else its kind's. */
export function needsYouLabel(item: Pick<NeedsYouItem, "kind" | "code" | "reason">): string {
  // These kinds say what to do; their codes only say what happened.
  return item.code !== null &&
    Object.hasOwn(REASON_LABEL, item.code) &&
    item.kind !== "outcomeFlawed" &&
    item.kind !== "revertConflict"
    ? REASON_LABEL[item.code]!.label
    : NEEDS_YOU_LABEL[item.kind];
}

const CRITERIA_REASON =
  "Work starts only once a person confirms them; they are what checks and review hold the work to.";
const NO_CRITERIA_CODE = "criteriaMissing";
const NO_CRITERIA_REASON =
  "It has no acceptance criteria. Add some, so checks and review have something to hold the work to.";
/** The scheduler's wait when a card's agent lacks write access; it waits on a person. */
const DELEGATE_READ_ONLY_CODE = "delegateReadOnly";
const PERSON_WAIT_CODES: ReadonlySet<string> = new Set([
  DELEGATE_READ_ONLY_CODE,
  "sideEffectGuard",
  ...BUDGET_WAIT_CODES,
]);
/** Attention codes that are their own Needs you kinds; the rest read as "attention". */
const ATTENTION_KINDS: Readonly<Record<string, NeedsYouKind>> = {
  outcomeFlawed: "outcomeFlawed",
  revertConflict: "revertConflict",
};
const SIDE_EFFECT_GUARD_REASON =
  "Agents don't start work until someone checks this project's scheduled jobs and outbound APIs in project settings.";

type NeedsYouProject = Pick<OrchestrationProjectShell, "id" | "orchestration" | "knowledge">;

/**
 * Everything across projects waiting on a person, longest waiting first. Derived,
 * never stored; snoozed cards drop out until their time or their next activity.
 * Pass `projects` to include each project's unacknowledged side-effect guard.
 */
export function needsYouItems(input: {
  readonly cards: ReadonlyArray<OrchestrationCard>;
  readonly sessions: ReadonlyArray<CardSessionSummary>;
  readonly projects?: ReadonlyArray<NeedsYouProject>;
  readonly now: number;
}): ReadonlyArray<NeedsYouItem> {
  // Keyed, so two rules that reach the same wait (a system pause after failed restarts and a
  // failed session) show it once.
  const items = new Map<string, NeedsYouItem>();
  const add = (item: NeedsYouItem) => {
    if (!items.has(item.key)) items.set(item.key, item);
  };
  const cardsById = new Map(input.cards.map((card) => [card.id, card] as const));
  const guardedProjects = new Set(
    (input.projects ?? [])
      .filter((project) => projectOrchestrationOf(project).sideEffectGuard.acknowledgedAt === null)
      .map((project) => project.id),
  );
  const verifyingProjects = new Set(
    (input.projects ?? [])
      .filter((project) => projectOrchestrationOf(project).verifier.mode === "on")
      .map((project) => project.id),
  );
  for (const card of input.cards) {
    const base = {
      cardId: card.id,
      projectId: card.projectId,
      title: card.title,
      snoozable: true,
      reason: null,
      code: null,
      activityId: null,
      lessonId: null,
    };
    const open = isOpenStatus(card.status);
    // A flawed outcome is found after a card lands, so it waits on a person on a finished card.
    for (const item of card.attention) {
      if (item.code !== "outcomeFlawed") continue;
      add({
        ...base,
        key: `attention:${item.activityId}`,
        kind: ATTENTION_KINDS[item.code] ?? "attention",
        since: item.createdAt,
        reason: item.text,
        code: item.code,
        activityId: item.activityId,
      });
    }
    if (card.status === "triage") {
      add({
        ...base,
        key: `triage:${card.id}`,
        kind: "triage",
        since: card.createdAt,
        reason:
          card.estimate?.split != null
            ? `The lead suggests splitting it: ${card.estimate.split.reason}`
            : (card.premise?.pushback ?? null),
      });
    } else if (card.specState === "draft" && card.spec.trim().length > 0 && open) {
      add({ ...base, key: `spec:${card.id}`, kind: "spec", since: card.updatedAt });
    }
    if (!open) {
      continue;
    }
    if (card.status !== "triage" && card.acceptance.state === "draft") {
      add({
        ...base,
        key: `criteria:${card.id}`,
        kind: "criteria",
        since: card.updatedAt,
        reason: CRITERIA_REASON,
      });
    } else if (
      card.status !== "triage" &&
      card.acceptance.criteria.length === 0 &&
      // A Linear issue without criteria already says so as its own attention item.
      !card.attention.some((item) => item.code === NO_CRITERIA_CODE)
    ) {
      // Cards from before criteria were confirmed with none; starting work needs some.
      add({
        ...base,
        key: `criteria:${card.id}`,
        kind: "criteria",
        since: card.updatedAt,
        reason: NO_CRITERIA_REASON,
        code: NO_CRITERIA_CODE,
      });
    }
    if ((card.status === "ready" || card.status === "inProgress") && card.paused === null) {
      if (card.delegateAgentId === null) {
        add({ ...base, key: `agent:${card.id}`, kind: "needsAgent", since: card.updatedAt });
      } else if (card.waitReason?.code === DELEGATE_READ_ONLY_CODE) {
        add({
          ...base,
          key: `readOnly:${card.id}`,
          kind: "delegateReadOnly",
          since: card.waitReason.since,
          reason: card.waitReason.text,
          code: DELEGATE_READ_ONLY_CODE,
        });
      } else if (card.waitReason !== null && BUDGET_WAIT_CODES.has(card.waitReason.code)) {
        // One item per project and cap: every card it holds waits on the same raise.
        add({
          ...base,
          key: `budgetCap:${card.projectId}:${card.waitReason.code}`,
          kind: "budgetCap",
          since: card.waitReason.since,
          reason: card.waitReason.text,
          code: card.waitReason.code,
          snoozable: false,
        });
      }
    }
    if (card.checkpoint !== null) {
      add({
        ...base,
        key: `checkpoint:${card.id}`,
        // A plan's or migration's checkpoint comes after a slice or sample lands.
        kind: card.kind === "plan" || card.kind === "migration" ? "sliceCheckpoint" : "checkpoint",
        since: card.checkpoint.requestedAt,
        reason: card.checkpoint.question ?? card.checkpoint.whatToTry,
        snoozable: false,
      });
    }
    // The card's open questions come with their words on its shell, one item each. A checkpoint's
    // shows above; a request for criteria shows as its attention item.
    const attentionIds = new Set(card.attention.map((item) => item.activityId));
    for (const question of card.openElicitations) {
      if (question.kind === "checkpoint" || attentionIds.has(question.activityId)) continue;
      if (question.kind === "refsChanged") {
        // Keyed like the pause it comes with, which shows (to resume) once the refs are decided.
        add({
          ...base,
          key: `paused:${card.id}`,
          kind: "refsChanged",
          since: question.askedAt,
          code: REF_GUARD_CODE,
          activityId: question.activityId,
          snoozable: false,
        });
        continue;
      }
      add({
        ...base,
        key: `question:${question.activityId}`,
        kind:
          question.kind === "criteriaChange"
            ? "criteriaChange"
            : question.kind === "plan"
              ? "planApproval"
              : "awaitingInput",
        since: question.askedAt,
        reason: question.question.length > 0 ? question.question : null,
        activityId: question.activityId,
        snoozable: false,
      });
    }
    for (const item of card.attention) {
      add({
        ...base,
        key: `attention:${item.activityId}`,
        kind: ATTENTION_KINDS[item.code] ?? "attention",
        since: item.createdAt,
        reason: item.text,
        code: item.code,
        activityId: item.activityId,
      });
    }
    // A person's own pause is their decision, not a wait; Iskra's pause asks for one.
    if (card.paused !== null && card.paused.by === "system") {
      const kind =
        card.paused.reason.code === "fixRoundsExhausted"
          ? "fixRoundsExhausted"
          : card.paused.reason.code === "sessionFailed"
            ? "sessionFailed"
            : "paused";
      add({
        ...base,
        key: `${kind === "sessionFailed" ? "failed" : kind}:${card.id}`,
        kind,
        since: card.paused.pausedAt,
        reason: card.paused.reason.text,
        code: card.paused.reason.code,
      });
    }
    if (
      guardedProjects.has(card.projectId) &&
      card.delegateAgentId !== null &&
      (card.status === "ready" || card.status === "inProgress")
    ) {
      add({
        ...base,
        key: `guard:${card.projectId}`,
        kind: "sideEffectGuard",
        since: card.updatedAt,
        reason: SIDE_EFFECT_GUARD_REASON,
        snoozable: false,
      });
    }
    if (card.status === "inReview") {
      if (card.evidence !== null) {
        if (card.evidence.unavailable.length > 0) {
          add({
            ...base,
            key: `evidence:${card.id}`,
            kind: "evidenceMissing",
            since: card.evidence.recordedAt,
            reason: `${NO_PREVIEW_HOST_TEXT} (${card.evidence.unavailable.join(", ")}).`,
          });
        }
        if (card.evidence.passed && hasUnacknowledgedHardFlags(card.evidence)) {
          add({
            ...base,
            key: `flags:${card.id}`,
            kind: "scopeFlags",
            since: card.evidence.recordedAt,
            reason: card.evidence.flags
              .filter((flag) => flag.hard)
              .map((flag) => `${flag.path}: ${flag.detail}`)
              .join("; "),
          });
        } else if (
          card.evidence.passed &&
          (card.evidence.pendingCi ?? []).length === 0 &&
          // A verifier still checking, or failed, holds the merge; the card waits on it, not a person.
          verifierMergeRefusal(
            card,
            verifyingProjects.has(card.projectId) || card.verification.state !== "off",
          ) === null
        ) {
          // With CI still pending the merge is refused, so the card waits on CI, not a person.
          add({
            ...base,
            key: `merge:${card.id}`,
            kind: "readyToMerge",
            since: card.evidence.recordedAt,
          });
        }
      } else if (card.checks !== null) {
        // Cards reviewed before evidence still carry the old checks summary.
        if (card.checks.state === "passed") {
          add({
            ...base,
            key: `merge:${card.id}`,
            kind: "readyToMerge",
            since: card.checks.updatedAt,
          });
        } else if (
          card.checks.state === "failed" &&
          card.checks.failedRuns >= CARD_AUTOFIX_ATTEMPTS
        ) {
          add({
            ...base,
            key: `fixRoundsExhausted:${card.id}`,
            kind: "fixRoundsExhausted",
            since: card.checks.updatedAt,
            reason: card.checks.summary.length > 0 ? card.checks.summary : null,
          });
        }
      }
    }
    // Invariant 13: a card that may not spend waits on a person.
    if (card.spentUsd >= card.budgetCapUsd) {
      add({ ...base, key: `budget:${card.id}`, kind: "budgetReached", since: card.activityAt });
    } else if (card.unpricedTurns > 0 && !card.acceptsUnpriced) {
      add({ ...base, key: `unpriced:${card.id}`, kind: "unpricedModel", since: card.activityAt });
    }
  }
  for (const session of input.sessions) {
    const card = cardsById.get(session.cardId);
    if (card === undefined) {
      continue;
    }
    const base = {
      cardId: card.id,
      projectId: card.projectId,
      title: card.title,
      since: session.since,
      reason: null,
      code: null,
      activityId: null,
      lessonId: null,
    };
    if (session.state === "awaitingInput") {
      // An open question already says what the session waits on.
      if (card.openElicitations.some((question) => question.kind !== "checkpoint")) continue;
      add({ ...base, key: `input:${card.id}`, kind: "awaitingInput", snoozable: false });
    } else if (session.state === "error" || session.state === "stale") {
      add({ ...base, key: `failed:${card.id}`, kind: "sessionFailed", snoozable: true });
    }
  }
  // Lessons are the project's, decided from the card they came from.
  for (const project of input.projects ?? []) {
    for (const lesson of project.knowledge ?? []) {
      const card = lesson.sourceCardId === null ? undefined : cardsById.get(lesson.sourceCardId);
      if (lesson.state !== "proposed" || card === undefined) continue;
      add({
        key: `lesson:${lesson.lessonId}`,
        kind: "lessonProposed",
        cardId: card.id,
        projectId: project.id,
        title: card.title,
        since: lesson.createdAt,
        reason: lesson.text,
        code: null,
        activityId: null,
        lessonId: lesson.lessonId,
        snoozable: false,
      });
    }
  }
  return (
    [...items.values()]
      .filter((item) => {
        const card = cardsById.get(item.cardId);
        return !item.snoozable || card === undefined || !isCardSnoozed(card, input.now);
      })
      // The filter's copy is sorted in place: Hermes has no Array#toSorted.
      .sort((left, right) => Date.parse(left.since) - Date.parse(right.since))
  );
}

interface CardWaitItem {
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly label: string;
  readonly reason: string;
  readonly since: string;
}

/**
 * Cards that could run but wait on Iskra or CI, such as machine capacity or a pull request's
 * checks: shown for information beside Needs you, never counted in it, since nothing waits on a
 * person.
 */
export function cardWaitItems(
  cards: ReadonlyArray<OrchestrationCard>,
): ReadonlyArray<CardWaitItem> {
  return cards
    .flatMap((card): CardWaitItem[] => {
      if (card.paused !== null || !isOpenStatus(card.status)) return [];
      const base = { cardId: card.id, projectId: card.projectId, title: card.title };
      const pendingCi = card.evidence?.pendingCi ?? [];
      return [
        // A wait only a person can end is a Needs you item instead.
        ...(card.waitReason === null || PERSON_WAIT_CODES.has(card.waitReason.code)
          ? []
          : [
              {
                ...base,
                label: reasonLabel(card.waitReason).label,
                reason: card.waitReason.text,
                since: card.waitReason.since,
              },
            ]),
        ...(card.status === "inReview" && card.evidence !== null && pendingCi.length > 0
          ? [
              {
                ...base,
                label: REASON_LABEL.pendingCi!.label,
                reason: `No result yet from ${pendingCi.join(", ")}.`,
                since: card.evidence.recordedAt,
              },
            ]
          : []),
      ];
    })
    .sort((left, right) => Date.parse(left.since) - Date.parse(right.since));
}

/** How long an item has waited, at the coarsest unit that says it: "4m", "3h", "2d". */
export function waitingLabel(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

type ElicitationChoice = { readonly optionId: string } | { readonly text: string };

/**
 * The answer a person's choice sends: an offered option by its label, or their own words when the
 * question takes them. Null when the choice isn't one the question accepts, so nothing is sent.
 */
export function elicitationAnswer(
  elicitation: Pick<Elicitation, "options" | "allowText">,
  choice: ElicitationChoice,
): { readonly optionId: string | null; readonly body: string } | null {
  if ("optionId" in choice) {
    const option = elicitation.options.find((entry) => entry.id === choice.optionId);
    return option === undefined ? null : { optionId: option.id, body: option.label };
  }
  const body = choice.text.trim();
  return elicitation.allowText && body.length > 0 ? { optionId: null, body } : null;
}

/** The questions a card's shell answers in place, by kind; a checkpoint and changed refs have their own controls. */
export const CARD_QUESTION_KINDS: ReadonlyArray<ElicitationKind> = ["question", "criteriaChange"];

const REF_GUARD_CODE = "refMovedOutsideCard";

/** The activity a card's open checkpoint is answered on, or null when none is open. */
export function openCheckpointActivityId(
  card: Pick<OrchestrationCard, "openElicitations">,
): string | null {
  return card.openElicitations.find((open) => open.kind === "checkpoint")?.activityId ?? null;
}

export type CardActivityFilter = "all" | "people" | "agents";

/** A card's activity narrowed to what people wrote or what agents did; Iskra's own entries show under all. */
export function filterCardActivities(
  activities: ReadonlyArray<CardActivity>,
  filter: CardActivityFilter,
): ReadonlyArray<CardActivity> {
  if (filter === "all") return activities;
  return activities.filter((activity) =>
    filter === "agents"
      ? activity.author.kind === "agent"
      : activity.author.kind !== "agent" && activity.author.kind !== "system",
  );
}
