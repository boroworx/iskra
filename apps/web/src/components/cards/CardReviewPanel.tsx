import {
  CRITERION_STATE_LABEL,
  SCOPE_FLAG_LABEL,
  ciSummary,
  fixRoundsView,
  reviewByCriterion,
  riskClaimsOf,
  type EvidenceItemView,
} from "@iskra/client-runtime/card-review";
import {
  markOfCriterionState,
  type CriterionMark,
  type PillTone,
} from "@iskra/client-runtime/card-face";
import {
  OVERRIDE_REASON_REQUIRED_TEXT,
  hasUnacknowledgedHardFlags,
  openCheckpointActivityId,
  overrideVerifierRefusal,
  reasonLabel,
  rerunVerifierRefusal,
} from "@iskra/client-runtime/cards";
import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import {
  type AssetResource,
  type CardActivity,
  type CardCheckpointDecision,
  type CardEvidenceItem,
  type CardVerdict,
  type CardVerification,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type ProjectOrchestration,
} from "@iskra/contracts";
import { memo, useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentProviders } from "../channels/AgentModelPicker";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { StatusPill } from "../iskra/StatusPill";
import { DisabledReason } from "./DisabledReason";

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

const NO_ITEMS: ReadonlyArray<CardEvidenceItem> = [];
const CHECKS_ANCHOR = "card-review-checks";

const MARK_TONE: Record<CriterionMark, PillTone> = {
  passed: "green",
  failed: "red",
  needsYou: "orange",
  pending: "gray",
};

// A grouped inset list, as macOS settings group rows on one rounded surface.
const GROUP_CLASS =
  "flex flex-col overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]";

/**
 * A card's review, organized by its acceptance criteria: the evidence captured for each, what
 * needs a person's own check, the scope judge's flags to acknowledge, and the diff last. Evidence
 * items come from the card's subscription; they belong to the card's latest evidence.
 */
export function CardReview(props: {
  readonly card: OrchestrationCardShell;
  readonly evidence: {
    readonly evidenceId: string;
    readonly items: ReadonlyArray<CardEvidenceItem>;
  } | null;
  /** The card's activity, where the agent's review request carries its risk claims. */
  readonly activities: ReadonlyArray<CardActivity>;
  /** The card's latest verdict, from its subscription. */
  readonly verdict: CardVerdict | null;
  /** Whether a passing verifier is needed before the merge. */
  readonly verificationRequired: boolean;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const acknowledge = useAtomCommand(cardEnvironment.acknowledgeFlags);
  const claims = useMemo(() => riskClaimsOf(props.activities), [props.activities]);
  const summary = card.evidence;
  // Items streamed for an older recording than the card's latest would describe the wrong commit.
  const items =
    props.evidence !== null && summary !== null && props.evidence.evidenceId === summary.evidenceId
      ? props.evidence.items
      : NO_ITEMS;
  // Likewise a verdict for an older commit judges code the card no longer has.
  const verdict =
    props.verdict !== null && summary !== null && props.verdict.headSha === summary.headSha
      ? props.verdict
      : null;
  const review = useMemo(
    () =>
      reviewByCriterion({ cardId: card.id, criteria: card.acceptance.criteria, items, verdict }),
    [card.id, card.acceptance.criteria, items, verdict],
  );
  // Screenshots numbered in reading order, so a note can point at "Exhibit 2".
  const exhibits = useMemo(
    () =>
      new Map(
        [...review.criteria.flatMap((entry) => entry.items), ...review.general]
          .filter((view) => view.item.kind === "screenshot" && view.artifact !== null)
          .map((view, index) => [view.item.itemId, index + 1] as const),
      ),
    [review],
  );

  if (summary === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No evidence yet. Iskra captures it when the agent asks for review or a checkpoint.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {summary.purpose === "checkpoint" ? "Checkpoint evidence" : "Evidence"} for{" "}
        <span className="tabular-nums">{summary.headSha.slice(0, 7)}</span> ·{" "}
        <span
          className={summary.passed ? "text-success-foreground" : "text-destructive-foreground"}
        >
          {summary.passed ? "passed" : "failed"}
        </span>{" "}
        · {new Date(summary.recordedAt).toLocaleString()}
      </p>

      {claims !== null ? (
        <div className="flex flex-col gap-0.5 text-xs">
          <h4 className="font-medium text-muted-foreground">The agent's claims</h4>
          <p>
            Side effects {claims.sideEffect} · performance {claims.performance} · compatibility{" "}
            {claims.compatibility}
          </p>
          {claims.notes.length > 0 ? (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{claims.notes}</p>
          ) : null}
          <p className="text-muted-foreground">Its own assessment when it asked for review, not evidence.</p>
        </div>
      ) : null}

      {props.verificationRequired ? (
        <VerifierPanel
          card={card}
          verdict={verdict}
          agents={props.agents}
          environmentId={environmentId}
        />
      ) : null}

      {review.criteria.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This card has no acceptance criteria, so only its checks speak for it.
        </p>
      ) : (
        <ol aria-label="Criteria" className={GROUP_CLASS}>
          {review.criteria.map((entry) => (
            <li
              key={entry.criterion.id}
              className="flex flex-col gap-1 border-t border-border px-3.5 py-2.5 first:border-t-0"
            >
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-sm">{entry.criterion.text}</span>
                <StatusPill
                  label={CRITERION_STATE_LABEL[entry.state]}
                  tone={MARK_TONE[markOfCriterionState(entry.state)]}
                />
              </div>
              {entry.verdict !== null &&
              (entry.verdict.note.length > 0 || entry.verdict.evidence.length > 0) ? (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {entry.verdict.note.length > 0 ? entry.verdict.note : entry.verdict.evidence}
                </p>
              ) : null}
              {entry.state === "needsYourCheck" ? (
                <p className="text-xs text-muted-foreground">
                  Check this yourself; the evidence below only covers what automation can.
                </p>
              ) : null}
              {entry.state === "coveredByChecks" ? (
                <p className="text-xs text-muted-foreground">
                  Nothing was captured for it alone, and the project's{" "}
                  <a href={`#${CHECKS_ANCHOR}`} className="underline underline-offset-2">
                    checks
                  </a>{" "}
                  passed.
                </p>
              ) : null}
              {entry.items.length > 0 ? (
                <EvidenceList items={entry.items} exhibits={exhibits} environmentId={environmentId} />
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {review.general.length > 0 ? (
        <div id={CHECKS_ANCHOR} className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Checks</h4>
          <EvidenceList items={review.general} exhibits={exhibits} environmentId={environmentId} />
        </div>
      ) : null}

      {summary.flags.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Flagged changes</h4>
          <ul className="flex flex-col gap-0.5 text-xs">
            {summary.flags.map((flag) => (
              <li key={`${flag.kind}:${flag.path}`} className="flex min-w-0 gap-2">
                <span
                  className={flag.hard ? "text-destructive-foreground" : "text-muted-foreground"}
                >
                  {SCOPE_FLAG_LABEL[flag.kind]}
                </span>
                <span className="min-w-0 truncate font-mono">{flag.path}</span>
                {flag.detail.length > 0 ? (
                  <span className="min-w-0 truncate text-muted-foreground">{flag.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {hasUnacknowledgedHardFlags(summary) ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() =>
                void acknowledge({
                  environmentId,
                  input: { cardId: card.id, evidenceId: summary.evidenceId },
                }).then(refused("The flags were not acknowledged"))
              }
            >
              Acknowledge flagged changes
            </Button>
          ) : summary.flagsAcknowledgedAt !== null ? (
            <p className="text-xs text-muted-foreground">Acknowledged.</p>
          ) : null}
        </div>
      ) : null}

      <CardDiff card={card} environmentId={environmentId} />
    </div>
  );
}

const VERIFICATION_TITLE: Record<CardVerification["state"], string> = {
  off: "Waiting for the verifier",
  pending: "Waiting for the verifier",
  running: "Verifying…",
  passed: "Verified",
  failed: "The verifier didn't pass this commit",
  overridden: "Verifier overridden",
};

/**
 * The verifier's side of review: who checks the card and why that one, what it found beyond the
 * criteria (diff concerns, hidden scenarios as counts only), and a rerun or a person's override.
 */
function VerifierPanel(props: {
  readonly card: OrchestrationCardShell;
  /** The verdict for the card's latest commit, if any. */
  readonly verdict: CardVerdict | null;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const decide = useAtomCommand(cardEnvironment.decide);
  const override = useAtomCommand(cardEnvironment.overrideVerifier);
  const providers = useEnvironmentProviders(environmentId);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const { verification } = card;
  const selection = verification.verifier;
  const why = selection === null ? null : reasonLabel(selection.reason);
  const provider =
    selection === null
      ? null
      : (deriveProviderInstanceEntries(providers).find(
          (entry) => entry.instanceId === selection.instanceId,
        )?.displayName ?? selection.instanceId);
  const verifierName =
    selection === null
      ? null
      : (props.agents.find((agent) => agent.id === selection.agentId)?.name ?? "verifier");
  const rerunRefusal = rerunVerifierRefusal(card);
  const overrideRefusal = overrideVerifierRefusal(card, true);
  const satisfaction = verification.satisfaction;
  const judge = props.verdict?.diffJudge;
  const trimmedReason = reason.trim();

  const run = async (request: Promise<AtomCommandResult<unknown, unknown>>, failure: string) => {
    setSending(true);
    const result = await request;
    setSending(false);
    refused(failure)(result);
    return result._tag === "Success";
  };

  return (
    <section aria-label="Verifier" className="flex flex-col gap-1.5 text-xs">
      <h4 className="text-sm font-medium">{VERIFICATION_TITLE[verification.state]}</h4>
      {selection !== null && why !== null ? (
        <DisabledReason reason={why.hint}>
          <span className="text-muted-foreground">
            @{verifierName} on {provider} · {selection.model} — {why.label}
          </span>
        </DisabledReason>
      ) : null}
      {verification.override !== null ? (
        <p className="text-muted-foreground">You overrode it: {verification.override.reason}</p>
      ) : null}
      {satisfaction !== null && satisfaction.total > 0 ? (
        <p className="tabular-nums">
          Hidden scenarios {satisfaction.satisfied}/{satisfaction.total} satisfied
        </p>
      ) : null}
      {judge !== undefined && (!judge.matchesCriteria || judge.concerns.length > 0) ? (
        <div className="flex flex-col gap-0.5">
          <p className={judge.matchesCriteria ? "text-muted-foreground" : "text-destructive-foreground"}>
            {judge.matchesCriteria
              ? "The diff does what the criteria ask, with concerns:"
              : "The diff doesn't do what the criteria ask."}
          </p>
          {judge.concerns.length > 0 ? (
            <ul className="list-disc ps-4">
              {judge.concerns.map((concern) => (
                <li key={concern} className="break-words">
                  {concern}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <DisabledReason reason={rerunRefusal}>
          <Button
            size="sm"
            variant="outline"
            disabled={rerunRefusal !== null || sending}
            onClick={() =>
              void run(
                decide({ environmentId, input: { type: "card.verifier.rerun", cardId: card.id } }),
                "The verifier was not rerun",
              )
            }
          >
            Rerun verifier
          </Button>
        </DisabledReason>
        {overrideRefusal === null && !overriding ? (
          <Button size="sm" variant="ghost-muted" onClick={() => setOverriding(true)}>
            Override…
          </Button>
        ) : null}
      </div>
      {overriding ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            aria-label="Why you're overriding the verifier"
            placeholder="Why this card may merge without the verifier passing"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <DisabledReason reason={trimmedReason.length === 0 ? OVERRIDE_REASON_REQUIRED_TEXT : null}>
              <Button
                size="sm"
                disabled={trimmedReason.length === 0 || sending}
                onClick={async () => {
                  const done = await run(
                    override({ environmentId, input: { cardId: card.id, reason: trimmedReason } }),
                    "The verifier was not overridden",
                  );
                  if (done) {
                    setOverriding(false);
                    setReason("");
                  }
                }}
              >
                Save override
              </Button>
            </DisabledReason>
            <Button
              size="sm"
              variant="ghost-muted"
              onClick={() => {
                setOverriding(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EvidenceList(props: {
  readonly items: ReadonlyArray<EvidenceItemView>;
  /** Each screenshot's exhibit number. */
  readonly exhibits: ReadonlyMap<string, number>;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {props.items.map((view) => (
        <EvidenceRow
          key={view.item.itemId}
          view={view}
          exhibit={props.exhibits.get(view.item.itemId)}
          environmentId={props.environmentId}
        />
      ))}
    </ul>
  );
}

const EvidenceRow = memo(function EvidenceRow(props: {
  readonly view: EvidenceItemView;
  readonly exhibit: number | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const { item, state } = props.view;
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted px-2.5 py-2 text-xs">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">
          {item.name}
          <span className="text-muted-foreground"> · {item.source}</span>
        </span>
        {item.durationMs !== null ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {Math.round(item.durationMs / 1000)}s
          </span>
        ) : null}
        <span
          className={cn(
            "shrink-0",
            state === "failed"
              ? "text-destructive-foreground"
              : state === "unavailable"
                ? "text-warning-foreground"
                : "text-muted-foreground",
          )}
        >
          {state === "failed" && item.timedOut
            ? "Timed out"
            : state === "failed"
              ? `Exit ${item.exitCode}`
              : state === "pending"
                ? "Waiting for CI"
                : state === "unavailable"
                  ? "Not captured"
                  : state === "passed"
                    ? "Passed"
                    : "Captured"}
        </span>
      </div>
      {state === "unavailable" && props.view.unavailableText !== null ? (
        <p className="text-muted-foreground">{props.view.unavailableText}</p>
      ) : null}
      {(item.kind === "check" || item.kind === "journey") && item.logTail.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Output tail</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
            {item.logTail}
          </pre>
        </details>
      ) : null}
      {props.view.artifact !== null ? (
        <EvidenceFile
          resource={props.view.artifact}
          item={item}
          exhibit={props.exhibit}
          environmentId={props.environmentId}
        />
      ) : null}
      {props.view.log !== null ? (
        <EvidenceFile resource={props.view.log} item={item} environmentId={props.environmentId} />
      ) : null}
    </li>
  );
});

/**
 * A screenshot inline, or a link to a recording or a check's full log (served as plain text),
 * through a signed asset URL.
 */
function EvidenceFile(props: {
  readonly resource: AssetResource;
  readonly item: CardEvidenceItem;
  readonly exhibit?: number | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  if (url._tag === "Loading") return <span className="text-muted-foreground">Loading…</span>;
  if (url._tag === "Failure") {
    return <span className="text-muted-foreground">The file is no longer available.</span>;
  }
  return props.resource._tag !== "card-check-log" && props.item.kind === "screenshot" ? (
    <figure className="flex flex-col gap-1.5">
      <a href={url.url} target="_blank" rel="noreferrer">
        <img
          src={url.url}
          alt={props.item.name}
          loading="lazy"
          className="max-h-64 w-auto rounded-lg shadow-[0_0_0_0.5px_var(--border)]"
        />
      </a>
      {props.exhibit !== undefined ? (
        <figcaption className="text-muted-foreground">Exhibit {props.exhibit}</figcaption>
      ) : null}
    </figure>
  ) : (
    <a href={url.url} target="_blank" rel="noreferrer" className="self-start underline">
      {props.resource._tag === "card-check-log"
        ? "Full log"
        : props.item.kind === "recording"
          ? "Open the recording"
          : "Open the file"}
    </a>
  );
}

/** The diff, closed by default and fetched only once opened. */
function CardDiff(props: {
  readonly card: OrchestrationCardShell;
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const stat = props.card.diffStat;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Diff
        {stat !== null && stat.files > 0
          ? ` · ${stat.files} file${stat.files === 1 ? "" : "s"} +${stat.additions} −${stat.deletions}`
          : ""}
      </summary>
      {open ? <CardDiffBody cardId={props.card.id} environmentId={props.environmentId} /> : null}
    </details>
  );
}

function CardDiffBody(props: {
  readonly cardId: OrchestrationCardShell["id"];
  readonly environmentId: EnvironmentId;
}) {
  const diff = useEnvironmentQuery(
    cardEnvironment.diff({ environmentId: props.environmentId, input: { cardId: props.cardId } }),
  );
  if (diff.error !== null) return <p className="text-xs text-destructive">{diff.error}</p>;
  if (diff.data === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  return (
    <pre className="mt-1 max-h-96 overflow-auto whitespace-pre font-mono text-[11px]">
      {diff.data.diff.length === 0 ? "No changes." : diff.data.diff}
      {diff.data.truncated ? "\n… truncated" : ""}
    </pre>
  );
}

/**
 * Where the card lands: its pull request (or local fast-forward), CI as the evidence reads it, and
 * the fix rounds used against the project's caps with a reset. Comments to forward are attention.
 */
export function CardLandingPanel(props: {
  readonly card: OrchestrationCardShell;
  readonly items: ReadonlyArray<CardEvidenceItem>;
  readonly policy: ProjectOrchestration;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const decide = useAtomCommand(cardEnvironment.decide);
  const rounds = fixRoundsView(card.fixRounds, props.policy);
  const ci = useMemo(() => ciSummary(props.items), [props.items]);
  const roundsOut = rounds.exhausted || card.paused?.reason.code === "fixRoundsExhausted";
  const landing = card.landing;

  return (
    <div className="flex flex-col gap-2 text-xs">
      <p>
        {card.status === "landed" && landing?.mergedOnHostUrl !== undefined ? (
          <span>
            <a href={landing.mergedOnHostUrl} target="_blank" rel="noreferrer" className="underline">
              Merged on the host
            </a>{" "}
            ·{" "}
          </span>
        ) : null}
        {landing === null ? (
          <span className="text-muted-foreground">Not linked to a pull request yet.</span>
        ) : landing.mode === "local" ? (
          <span>Lands locally by fast-forwarding the base branch.</span>
        ) : landing.url !== null ? (
          <>
            <a href={landing.url} target="_blank" rel="noreferrer" className="underline">
              Pull request{landing.number !== null ? ` #${landing.number}` : ""}
            </a>
            {landing.draft ? <span className="text-muted-foreground"> · draft</span> : null}
          </>
        ) : (
          <span>Pull request opening…</span>
        )}
      </p>
      {landing?.mode === "pullRequest" ? (
        <p
          className={ci.failed.length > 0 ? "text-destructive-foreground" : "text-muted-foreground"}
        >
          {ci.total === 0
            ? "No CI results yet."
            : ci.failed.length > 0
              ? `CI failing: ${ci.failed.join(", ")}`
              : ci.pending.length > 0
                ? `Waiting for CI: ${ci.pending.join(", ")}. The merge waits for it.`
                : `CI passed (${ci.total})`}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums text-muted-foreground">
          CI fixes {rounds.ci.used} of {rounds.ci.cap} · review fixes {rounds.review.used} of{" "}
          {rounds.review.cap}
        </span>
        {roundsOut ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void decide({
                environmentId,
                input: { type: "card.fix-rounds.reset", cardId: card.id },
              }).then(refused("The fix rounds were not reset"))
            }
          >
            Give it {Math.max(props.policy.ciFixRounds, props.policy.reviewFixRounds)} more rounds
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const CHECKPOINT_ANSWER: Record<CardCheckpointDecision, string> = {
  continue: "Continue",
  redirect: "Redirect",
  stop: "Stop",
};

/**
 * The owner's checkpoint: what it tried and asks, answered on its open question by continuing,
 * redirecting with a note, or stopping, which pauses the card.
 */
export function CheckpointControls(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "checkpoint" | "openElicitations">;
  readonly environmentId: EnvironmentId;
}) {
  const answer = useAtomCommand(cardEnvironment.answerElicitation);
  const [note, setNote] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [sending, setSending] = useState(false);
  const checkpoint = props.card.checkpoint;
  const activityId = openCheckpointActivityId(props.card);
  if (checkpoint === null || activityId === null) return null;

  const send = async (decision: CardCheckpointDecision) => {
    const trimmed = note.trim();
    setSending(true);
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        cardId: props.card.id,
        activityId,
        optionId: decision,
        body: trimmed.length > 0 ? trimmed : CHECKPOINT_ANSWER[decision],
      },
    });
    setSending(false);
    toastCommandFailure(result, "The checkpoint was not answered", "The request was refused.");
    if (result._tag === "Success") {
      setNote("");
      setRedirecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="whitespace-pre-wrap break-words text-sm">{checkpoint.whatToTry}</p>
      {checkpoint.question !== null ? (
        <p className="whitespace-pre-wrap break-words text-sm font-medium">{checkpoint.question}</p>
      ) : null}
      {redirecting ? (
        <Textarea
          aria-label="What to do instead"
          placeholder="What the agent should do instead"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={sending} onClick={() => void send("continue")}>
          Continue <span className="text-xs opacity-80">(recommended)</span>
        </Button>
        {redirecting ? (
          <Button
            size="sm"
            variant="outline"
            disabled={sending || note.trim().length === 0}
            onClick={() => void send("redirect")}
          >
            Send redirect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={sending}
            onClick={() => setRedirecting(true)}
          >
            Redirect…
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={sending}
          onClick={() => void send("stop")}
        >
          Stop
        </Button>
      </div>
    </div>
  );
}
