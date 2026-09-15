import {
  CRITERION_STATE_LABEL,
  SCOPE_FLAG_LABEL,
  ciSummary,
  fixRoundsView,
  reviewByCriterion,
  riskClaimsOf,
  type EvidenceItemState,
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
import { CircleAlertIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentProviders } from "../channels/AgentModelPicker";
import { toastCommandFailure } from "../toastCommandFailure";
import { Textarea } from "../ui/textarea";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { RoundDots } from "../iskra/Marks";
import { StatusPill } from "../iskra/StatusPill";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import {
  ActionButton,
  ClaimMarks,
  DisclosureRow,
  Group,
  Row,
  RowLink,
  Section,
  Trail,
  VerdictGlyph,
  type VerdictGlyphState,
} from "./cardChrome";
import { DisabledReason } from "./DisabledReason";

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

const NO_ITEMS: ReadonlyArray<CardEvidenceItem> = [];
const CHECKS_ANCHOR = "card-review-checks";

/** Pending and a person's check both read orange: something still has to happen before it's green. */
const MARK_GLYPH: Record<CriterionMark, VerdictGlyphState> = {
  passed: "passed",
  failed: "failed",
  needsYou: "pending",
  pending: "pending",
};

const ITEM_GLYPH: Record<EvidenceItemState, VerdictGlyphState> = {
  passed: "passed",
  failed: "failed",
  pending: "pending",
  unavailable: "pending",
  captured: "neutral",
};

const dateTime = (iso: string) => new Date(iso).toLocaleString();

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
  /** Requests fresh evidence, offered beside the checks while the card is in review. */
  readonly onCapture?: (() => void) | undefined;
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
  const exhibitViews = useMemo(
    () =>
      [...review.criteria.flatMap((entry) => entry.items), ...review.general].filter(
        (view) => view.item.kind === "screenshot" && view.artifact !== null,
      ),
    [review],
  );
  const exhibits = useMemo(
    () => new Map(exhibitViews.map((view, index) => [view.item.itemId, index + 1] as const)),
    [exhibitViews],
  );
  const capture =
    props.onCapture === undefined ? null : (
      <RowLink className="text-xs" onClick={props.onCapture}>
        Capture evidence
      </RowLink>
    );

  if (summary === null) {
    return (
      <Section label="Evidence" trailing={capture ?? undefined}>
        <p className="px-4 text-xs text-muted-foreground">
          No evidence yet. Iskra captures it when the agent asks for review or a checkpoint.
        </p>
      </Section>
    );
  }
  return (
    <>
      <Section label="Criteria">
        {review.criteria.length === 0 ? (
          <p className="px-4 text-xs text-muted-foreground">
            This card has no acceptance criteria, so only its checks speak for it.
          </p>
        ) : (
          <Group>
            {review.criteria.map((entry) => {
              const firstShot = entry.items.find(
                (view) => view.item.kind === "screenshot" && view.artifact !== null,
              );
              const note =
                entry.verdict === null
                  ? ""
                  : entry.verdict.note.length > 0
                    ? entry.verdict.note
                    : entry.verdict.evidence;
              const detailed =
                note.length > 0 ||
                entry.items.length > 0 ||
                entry.state === "needsYourCheck" ||
                entry.state === "coveredByChecks";
              return (
                <DisclosureRow
                  key={entry.criterion.id}
                  leading={
                    <VerdictGlyph
                      state={MARK_GLYPH[markOfCriterionState(entry.state)]}
                      label={CRITERION_STATE_LABEL[entry.state]}
                    />
                  }
                  label={entry.criterion.text}
                  trailing={
                    firstShot?.artifact != null ? (
                      <EvidenceThumb resource={firstShot.artifact} environmentId={environmentId} />
                    ) : undefined
                  }
                >
                  {detailed ? (
                    <>
                      <span className="text-muted-foreground">
                        {CRITERION_STATE_LABEL[entry.state]}
                      </span>
                      {note.length > 0 ? (
                        <p className="whitespace-pre-wrap break-words text-muted-foreground">
                          {note}
                        </p>
                      ) : null}
                      {entry.state === "needsYourCheck" ? (
                        <p className="text-muted-foreground">
                          Check this yourself; the evidence below only covers what automation can.
                        </p>
                      ) : null}
                      {entry.state === "coveredByChecks" ? (
                        <p className="text-muted-foreground">
                          Nothing was captured for it alone, and the project's{" "}
                          <a href={`#${CHECKS_ANCHOR}`} className="underline underline-offset-2">
                            checks
                          </a>{" "}
                          passed.
                        </p>
                      ) : null}
                      {entry.items.map((view) => (
                        <EvidenceDetail
                          key={view.item.itemId}
                          view={view}
                          exhibit={exhibits.get(view.item.itemId)}
                          environmentId={environmentId}
                          named
                        />
                      ))}
                    </>
                  ) : null}
                </DisclosureRow>
              );
            })}
          </Group>
        )}
      </Section>

      {exhibitViews.length > 0 ? (
        <Section label="Exhibits">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {exhibitViews.map((view) => (
              <ExhibitFigure
                key={view.item.itemId}
                resource={view.artifact!}
                name={view.item.name}
                exhibit={exhibits.get(view.item.itemId)!}
                environmentId={environmentId}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        id={CHECKS_ANCHOR}
        label="Checks"
        trailing={
          <>
            <span className="truncate tabular-nums">
              {summary.purpose === "checkpoint" ? "Checkpoint · " : ""}
              <span className="font-mono">{summary.headSha.slice(0, 7)}</span> ·{" "}
              <DisabledReason reason={dateTime(summary.recordedAt)}>
                <time dateTime={summary.recordedAt}>
                  {formatRelativeTimeLabel(summary.recordedAt)}
                </time>
              </DisabledReason>
            </span>
            <StatusPill
              label={summary.passed ? "Passed" : "Failed"}
              tone={summary.passed ? "green" : "red"}
            />
            {capture}
          </>
        }
      >
        {review.general.length === 0 ? (
          <p className="px-4 text-xs text-muted-foreground">No checks ran for this commit.</p>
        ) : (
          <Group className="tabular-nums">
            {review.general.map((view) => (
              <EvidenceRow
                key={view.item.itemId}
                view={view}
                exhibit={exhibits.get(view.item.itemId)}
                environmentId={environmentId}
              />
            ))}
          </Group>
        )}
      </Section>

      {summary.flags.length > 0 ? (
        <Section label="Flagged changes">
          <Group>
            {summary.flags.map((flag, index) => {
              const Icon = flag.kind === "deletedTest" ? Trash2Icon : CircleAlertIcon;
              const last = index === summary.flags.length - 1;
              return (
                <Row key={`${flag.kind}:${flag.path}`} className="py-2">
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-[18px] shrink-0",
                      flag.hard ? "text-warning" : "text-muted-foreground",
                    )}
                    strokeWidth={1.8}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "truncate font-mono text-xs",
                        flag.kind === "deletedTest" &&
                          "line-through decoration-muted-foreground/75",
                      )}
                    >
                      {flag.path}
                    </span>
                    <span className="truncate text-xs text-tertiary-label">
                      {SCOPE_FLAG_LABEL[flag.kind]}
                      {flag.detail.length > 0 ? ` · ${flag.detail}` : ""}
                    </span>
                  </span>
                  {last ? (
                    <Trail>
                      {hasUnacknowledgedHardFlags(summary) ? (
                        <RowLink
                          onClick={() =>
                            void acknowledge({
                              environmentId,
                              input: { cardId: card.id, evidenceId: summary.evidenceId },
                            }).then(refused("The flags were not acknowledged"))
                          }
                        >
                          Acknowledge
                        </RowLink>
                      ) : summary.flagsAcknowledgedAt !== null ? (
                        <span className="text-xs text-tertiary-label">Acknowledged</span>
                      ) : null}
                    </Trail>
                  ) : null}
                </Row>
              );
            })}
          </Group>
        </Section>
      ) : null}

      {claims !== null ? (
        <Section label="Agent's Claims">
          <Group>
            <Row>
              <span className="text-muted-foreground">Side effects</span>
              <Trail>
                <ClaimMarks label="Side effects" level={claims.sideEffect} />
              </Trail>
            </Row>
            <Row>
              <span className="text-muted-foreground">Performance</span>
              <Trail>
                <ClaimMarks label="Performance" level={claims.performance} />
              </Trail>
            </Row>
            <Row>
              <span className="text-muted-foreground">Compatibility</span>
              <Trail>
                <ClaimMarks label="Compatibility" level={claims.compatibility} />
              </Trail>
            </Row>
            {claims.notes.length > 0 ? (
              <DisclosureRow label={<span className="text-muted-foreground">Notes</span>}>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {claims.notes}
                </p>
              </DisclosureRow>
            ) : null}
          </Group>
          <p className="px-4 text-xs text-tertiary-label">
            Its own assessment when it asked for review, not evidence.
          </p>
        </Section>
      ) : null}

      {props.verificationRequired ? (
        <VerifierPanel
          card={card}
          verdict={verdict}
          agents={props.agents}
          environmentId={environmentId}
        />
      ) : null}

      <Section label="Diff">
        <Group>
          <CardDiff card={card} environmentId={environmentId} />
        </Group>
      </Section>
    </>
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

const VERIFICATION_PILL: Record<
  CardVerification["state"],
  { readonly label: string; readonly tone: PillTone }
> = {
  off: { label: "Waiting", tone: "gray" },
  pending: { label: "Waiting", tone: "gray" },
  running: { label: "Verifying", tone: "blue" },
  passed: { label: "Passed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  overridden: { label: "Overridden", tone: "orange" },
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
    <Section label={VERIFICATION_TITLE[verification.state]}>
      <Group>
        {selection !== null && verifierName !== null ? (
          <Row className="py-2">
            <AgentAvatar name={verifierName} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">@{verifierName}</span>
              {why !== null ? (
                <DisabledReason reason={why.hint}>
                  <span className="truncate text-xs text-tertiary-label">
                    {provider} · {selection.model} · {why.label}
                  </span>
                </DisabledReason>
              ) : null}
            </span>
            <Trail>
              <StatusPill {...VERIFICATION_PILL[verification.state]} />
            </Trail>
          </Row>
        ) : null}
        {verification.override !== null ? (
          <Row className="py-2.5">
            <span className="text-muted-foreground">
              You overrode it: {verification.override.reason}
            </span>
          </Row>
        ) : null}
        {satisfaction !== null && satisfaction.total > 0 ? (
          <Row>
            <span className="text-muted-foreground">Hidden scenarios</span>
            <Trail className="tabular-nums text-muted-foreground">
              {satisfaction.satisfied}/{satisfaction.total} satisfied
            </Trail>
          </Row>
        ) : null}
        {judge !== undefined && (!judge.matchesCriteria || judge.concerns.length > 0) ? (
          <DisclosureRow
            leading={<VerdictGlyph state={judge.matchesCriteria ? "pending" : "failed"} />}
            label={
              judge.matchesCriteria
                ? `The diff does what the criteria ask, with ${judge.concerns.length} concern${judge.concerns.length === 1 ? "" : "s"}`
                : "The diff doesn't do what the criteria ask"
            }
          >
            {judge.concerns.length > 0 ? (
              <ul className="list-disc ps-4 text-muted-foreground">
                {judge.concerns.map((concern) => (
                  <li key={concern} className="break-words">
                    {concern}
                  </li>
                ))}
              </ul>
            ) : null}
          </DisclosureRow>
        ) : null}
        <Row className="flex-wrap gap-2 py-2.5">
          <DisabledReason reason={rerunRefusal}>
            <ActionButton
              disabled={rerunRefusal !== null || sending}
              onClick={() =>
                void run(
                  decide({
                    environmentId,
                    input: { type: "card.verifier.rerun", cardId: card.id },
                  }),
                  "The verifier was not rerun",
                )
              }
            >
              Rerun verifier
            </ActionButton>
          </DisabledReason>
          {overrideRefusal === null && !overriding ? (
            <ActionButton onClick={() => setOverriding(true)}>Override…</ActionButton>
          ) : null}
          {overriding ? (
            <div className="flex w-full flex-col gap-2">
              <Textarea
                aria-label="Why you're overriding the verifier"
                placeholder="Why this card may merge without the verifier passing"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  onClick={() => {
                    setOverriding(false);
                    setReason("");
                  }}
                >
                  Cancel
                </ActionButton>
                <DisabledReason
                  reason={trimmedReason.length === 0 ? OVERRIDE_REASON_REQUIRED_TEXT : null}
                >
                  <ActionButton
                    tone="primary"
                    disabled={trimmedReason.length === 0 || sending}
                    onClick={async () => {
                      const done = await run(
                        override({
                          environmentId,
                          input: { cardId: card.id, reason: trimmedReason },
                        }),
                        "The verifier was not overridden",
                      );
                      if (done) {
                        setOverriding(false);
                        setReason("");
                      }
                    }}
                  >
                    Save override
                  </ActionButton>
                </DisabledReason>
              </div>
            </div>
          ) : null}
        </Row>
      </Group>
    </Section>
  );
}

function itemStateText(view: EvidenceItemView): string | null {
  const { item, state } = view;
  return state === "failed" && item.timedOut
    ? "Timed out"
    : state === "failed"
      ? `Exit ${item.exitCode}`
      : state === "pending"
        ? "Waiting for CI"
        : state === "unavailable"
          ? "Not captured"
          : state === "captured"
            ? "Captured"
            : null;
}

/** One check or capture as a row: its verdict, name and duration, opening to its output. */
const EvidenceRow = memo(function EvidenceRow(props: {
  readonly view: EvidenceItemView;
  readonly exhibit: number | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const { item, state } = props.view;
  const stateText = itemStateText(props.view);
  const hasDetail =
    (state === "unavailable" && props.view.unavailableText !== null) ||
    ((item.kind === "check" || item.kind === "journey") && item.logTail.length > 0) ||
    props.view.artifact !== null ||
    props.view.log !== null;
  return (
    <DisclosureRow
      leading={<VerdictGlyph state={ITEM_GLYPH[state]} label={stateText ?? "Passed"} />}
      label={
        <>
          {item.name}
          <span className="text-tertiary-label"> · {item.source}</span>
        </>
      }
      trailing={
        <>
          {stateText !== null && state !== "captured" ? (
            <span className="text-xs text-tertiary-label">{stateText}</span>
          ) : null}
          {item.durationMs !== null ? (
            <span className="text-tertiary-label">{Math.round(item.durationMs / 1000)}s</span>
          ) : null}
        </>
      }
    >
      {hasDetail ? (
        <EvidenceDetail view={props.view} exhibit={props.exhibit} environmentId={props.environmentId} />
      ) : null}
    </DisclosureRow>
  );
});

/** What an evidence item carries beyond its row: why it's missing, its output, and its files. */
function EvidenceDetail(props: {
  readonly view: EvidenceItemView;
  readonly exhibit: number | undefined;
  readonly environmentId: EnvironmentId;
  /** Names the item first, for evidence listed under a criterion. */
  readonly named?: boolean;
}) {
  const { item, state } = props.view;
  const stateText = itemStateText(props.view);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.named ? (
        <div className="flex min-w-0 items-center gap-2">
          <VerdictGlyph state={ITEM_GLYPH[state]} size={13} label={stateText ?? "Passed"} />
          <span className="min-w-0 truncate">
            {item.name}
            <span className="text-tertiary-label"> · {item.source}</span>
          </span>
          {item.durationMs !== null ? (
            <span className="ms-auto shrink-0 tabular-nums text-tertiary-label">
              {Math.round(item.durationMs / 1000)}s
            </span>
          ) : null}
        </div>
      ) : null}
      {state === "unavailable" && props.view.unavailableText !== null ? (
        <p className="text-muted-foreground">{props.view.unavailableText}</p>
      ) : null}
      {(item.kind === "check" || item.kind === "journey") && item.logTail.length > 0 ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px]">
          {item.logTail}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-x-3">
        {props.view.artifact !== null ? (
          <EvidenceLink
            resource={props.view.artifact}
            label={
              item.kind === "screenshot"
                ? props.exhibit !== undefined
                  ? `Exhibit ${props.exhibit}`
                  : "Open the screenshot"
                : item.kind === "recording"
                  ? "Open the recording"
                  : "Open the file"
            }
            environmentId={props.environmentId}
          />
        ) : null}
        {props.view.log !== null ? (
          <EvidenceLink resource={props.view.log} label="Full log" environmentId={props.environmentId} />
        ) : null}
      </div>
    </div>
  );
}

/** A recording, screenshot or check's full log (served as plain text), through a signed asset URL. */
function EvidenceLink(props: {
  readonly resource: AssetResource;
  readonly label: string;
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  if (url._tag === "Loading") return <span className="text-muted-foreground">Loading…</span>;
  if (url._tag === "Failure") {
    return <span className="text-muted-foreground">The file is no longer available.</span>;
  }
  return (
    <a
      href={url.url}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-info-foreground hover:underline"
    >
      {props.label}
    </a>
  );
}

function EvidenceThumb(props: {
  readonly resource: AssetResource;
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  return url._tag === "Success" ? (
    <img
      src={url.url}
      alt=""
      loading="lazy"
      className="h-6 w-9 rounded-[4px] object-cover object-top shadow-[0_0_0_0.5px_var(--border)]"
    />
  ) : (
    <span className="h-6 w-9 rounded-[4px] bg-muted shadow-[0_0_0_0.5px_var(--border)]" />
  );
}

/** A screenshot as a numbered exhibit, opening full size. */
function ExhibitFigure(props: {
  readonly resource: AssetResource;
  readonly name: string;
  readonly exhibit: number;
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2">
      {url._tag === "Success" ? (
        <a href={url.url} target="_blank" rel="noreferrer">
          <img
            src={url.url}
            alt={props.name}
            loading="lazy"
            className="h-40 w-full rounded-[10px] bg-card object-cover object-top shadow-[0_0_0_0.5px_var(--border)]"
          />
        </a>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-[10px] bg-card text-xs text-muted-foreground shadow-[0_0_0_0.5px_var(--border)]">
          {url._tag === "Loading" ? "Loading…" : "The file is no longer available."}
        </div>
      )}
      <figcaption className="truncate text-xs text-tertiary-label">
        Exhibit {props.exhibit} · {props.name}
      </figcaption>
    </figure>
  );
}

/** The diff, closed by default and fetched only once opened. */
function CardDiff(props: {
  readonly card: OrchestrationCardShell;
  readonly environmentId: EnvironmentId;
}) {
  const stat = props.card.diffStat;
  return (
    <DisclosureRow
      leading={<GitBranchIcon aria-hidden className="size-[18px] text-muted-foreground" />}
      label="Changes"
      trailing={
        stat !== null && stat.files > 0 ? (
          <span className="tabular-nums text-xs text-tertiary-label">
            {stat.files} file{stat.files === 1 ? "" : "s"} +{stat.additions} −{stat.deletions}
          </span>
        ) : undefined
      }
    >
      <CardDiffBody cardId={props.card.id} environmentId={props.environmentId} />
    </DisclosureRow>
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
    <pre className="-ms-[30px] max-h-96 overflow-auto whitespace-pre font-mono text-[11px]">
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
  let target: ReactNode;
  if (landing === null) {
    target = <span className="text-muted-foreground">Not linked to a pull request yet.</span>;
  } else if (landing.mode === "local") {
    target = <span>Lands locally by fast-forwarding the base branch.</span>;
  } else if (landing.url !== null) {
    target = (
      <>
        <a
          href={landing.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-info-foreground hover:underline"
        >
          Pull request{landing.number !== null ? ` #${landing.number}` : ""}
        </a>
        {landing.draft ? <StatusPill label="Draft" tone="gray" /> : null}
      </>
    );
  } else {
    target = <span>Pull request opening…</span>;
  }

  return (
    <Group>
      <Row className="flex-wrap py-2">
        <GitBranchIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
        {target}
        {card.status === "landed" && landing?.mergedOnHostUrl !== undefined ? (
          <Trail>
            <a
              href={landing.mergedOnHostUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-info-foreground hover:underline"
            >
              Merged on the host
            </a>
          </Trail>
        ) : null}
      </Row>
      {landing?.mode === "pullRequest" ? (
        <Row className="py-2">
          <VerdictGlyph
            state={
              ci.total === 0
                ? "neutral"
                : ci.failed.length > 0
                  ? "failed"
                  : ci.pending.length > 0
                    ? "pending"
                    : "passed"
            }
          />
          <span className="text-muted-foreground">
            {ci.total === 0
              ? "No CI results yet."
              : ci.failed.length > 0
                ? `CI failing: ${ci.failed.join(", ")}`
                : ci.pending.length > 0
                  ? `Waiting for CI: ${ci.pending.join(", ")}. The merge waits for it.`
                  : `CI passed (${ci.total})`}
          </span>
        </Row>
      ) : null}
      <Row className="flex-wrap py-2">
        <span className="text-muted-foreground">CI fix rounds</span>
        <Trail className="text-xs text-muted-foreground/75">
          <span className="inline-flex items-center gap-1.5">
            <RoundDots used={rounds.ci.used} cap={rounds.ci.cap} label="CI fix rounds" />
          </span>
          {roundsOut ? (
            <ActionButton
              onClick={() =>
                void decide({
                  environmentId,
                  input: { type: "card.fix-rounds.reset", cardId: card.id },
                }).then(refused("The fix rounds were not reset"))
              }
            >
              Give it {Math.max(props.policy.ciFixRounds, props.policy.reviewFixRounds)} more rounds
            </ActionButton>
          ) : null}
        </Trail>
      </Row>
    </Group>
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
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
        {checkpoint.whatToTry}
      </p>
      {checkpoint.question !== null ? (
        <p className="whitespace-pre-wrap break-words text-[13px] font-medium">
          {checkpoint.question}
        </p>
      ) : null}
      {redirecting ? (
        <Textarea
          aria-label="What to do instead"
          placeholder="What the agent should do instead"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton tone="tinted" disabled={sending} onClick={() => void send("continue")}>
          Continue <span className="sr-only">(recommended)</span>
        </ActionButton>
        {redirecting ? (
          <ActionButton
            disabled={sending || note.trim().length === 0}
            onClick={() => void send("redirect")}
          >
            Send redirect
          </ActionButton>
        ) : (
          <ActionButton disabled={sending} onClick={() => setRedirecting(true)}>
            Redirect…
          </ActionButton>
        )}
        <ActionButton tone="destructive" disabled={sending} onClick={() => void send("stop")}>
          Stop
        </ActionButton>
      </div>
    </div>
  );
}
