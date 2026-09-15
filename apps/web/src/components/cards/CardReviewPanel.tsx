import {
  CRITERION_STATE_LABEL,
  SCOPE_FLAG_LABEL,
  ciSummary,
  fixRoundsView,
  reviewByCriterion,
  riskClaimsOf,
  type CriterionState,
  type EvidenceItemView,
} from "@iskra/client-runtime/card-review";
import { hasUnacknowledgedHardFlags, openCheckpointActivityId } from "@iskra/client-runtime/cards";
import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import {
  type AssetResource,
  type CardActivity,
  type CardCheckpointDecision,
  type CardEvidenceItem,
  type EnvironmentId,
  type OrchestrationCardShell,
  type ProjectOrchestration,
} from "@iskra/contracts";
import { memo, useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

const NO_ITEMS: ReadonlyArray<CardEvidenceItem> = [];
const CHECKS_ANCHOR = "card-review-checks";

const STATE_CLASS: Record<CriterionState, string> = {
  passed: "text-success-foreground",
  failed: "text-destructive-foreground",
  pending: "text-muted-foreground",
  unavailable: "text-warning-foreground",
  needsYourCheck: "text-warning-foreground",
  coveredByChecks: "text-success-foreground",
  noEvidence: "text-muted-foreground",
};

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
  const review = useMemo(
    () => reviewByCriterion({ cardId: card.id, criteria: card.acceptance.criteria, items }),
    [card.id, card.acceptance.criteria, items],
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
        <span className="font-mono">{summary.headSha.slice(0, 7)}</span> ·{" "}
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

      {review.criteria.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This card has no acceptance criteria, so only its checks speak for it.
        </p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {review.criteria.map((entry) => (
            <li key={entry.criterion.id} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-sm">{entry.criterion.text}</span>
                <span className={cn("shrink-0 text-xs", STATE_CLASS[entry.state])}>
                  {CRITERION_STATE_LABEL[entry.state]}
                </span>
              </div>
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
                <EvidenceList items={entry.items} environmentId={environmentId} />
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {review.general.length > 0 ? (
        <div id={CHECKS_ANCHOR} className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Checks</h4>
          <EvidenceList items={review.general} environmentId={environmentId} />
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

function EvidenceList(props: {
  readonly items: ReadonlyArray<EvidenceItemView>;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {props.items.map((view) => (
        <EvidenceRow key={view.item.itemId} view={view} environmentId={props.environmentId} />
      ))}
    </ul>
  );
}

const EvidenceRow = memo(function EvidenceRow(props: {
  readonly view: EvidenceItemView;
  readonly environmentId: EnvironmentId;
}) {
  const { item, state } = props.view;
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-xs">
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
      {item.kind === "check" && item.logTail.length > 0 ? (
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
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  if (url._tag === "Loading") return <span className="text-muted-foreground">Loading…</span>;
  if (url._tag === "Failure") {
    return <span className="text-muted-foreground">The file is no longer available.</span>;
  }
  return props.resource._tag !== "card-check-log" && props.item.kind === "screenshot" ? (
    <a href={url.url} target="_blank" rel="noreferrer">
      <img
        src={url.url}
        alt={props.item.name}
        loading="lazy"
        className="max-h-64 w-auto rounded border border-border"
      />
    </a>
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
