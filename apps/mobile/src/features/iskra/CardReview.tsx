import {
  CRITERION_STATE_LABEL,
  SCOPE_FLAG_LABEL,
  ciSummary,
  fixRoundsView,
  reviewByCriterion,
  type EvidenceItemView,
} from "@iskra/client-runtime/card-review";
import { markOfCriterionState, type CriterionMark, type PillTone } from "@iskra/client-runtime/card-face";
import { hasUnacknowledgedHardFlags, rerunVerifierRefusal } from "@iskra/client-runtime/cards";
import type {
  AssetResource,
  CardEvidenceItem,
  CardVerdict,
  CardVerification,
  EnvironmentId,
  OrchestrationAgentShell,
  OrchestrationCardShell,
  ProjectOrchestration,
} from "@iskra/contracts";
import { memo, useMemo } from "react";
import { Image, Linking, Pressable, Text, View } from "react-native";

import { useAssetUrlState } from "../../state/assets";
import { ActionButton, Body, ButtonRow, Group, Muted, Row, StatusPill, TONE_COLOR } from "./components";
import { cardEnvironment, useRefusableCommand } from "./state";

const NO_ITEMS: ReadonlyArray<CardEvidenceItem> = [];

const MARK_TONE: Record<CriterionMark, PillTone> = {
  passed: "green",
  failed: "red",
  needsYou: "orange",
  pending: "gray",
};

const VERIFICATION_TITLE: Record<CardVerification["state"], string> = {
  off: "Waiting for the verifier",
  pending: "Waiting for the verifier",
  running: "Verifying…",
  passed: "Verified",
  failed: "The verifier didn't pass this commit",
  overridden: "Verifier overridden",
};

/** The evidence items that belong to the card's latest recording; older ones describe another commit. */
export function currentEvidenceItems(
  card: OrchestrationCardShell,
  evidence: { readonly evidenceId: string; readonly items: ReadonlyArray<CardEvidenceItem> } | null,
): ReadonlyArray<CardEvidenceItem> {
  return evidence !== null && card.evidence !== null && evidence.evidenceId === card.evidence.evidenceId
    ? evidence.items
    : NO_ITEMS;
}

/**
 * Review by acceptance criterion: each criterion's state from the verifier's verdict or its
 * evidence, screenshots as exhibits through the asset route, the checks, and flags to acknowledge.
 */
export function CardReview(props: {
  readonly card: OrchestrationCardShell;
  readonly items: ReadonlyArray<CardEvidenceItem>;
  readonly verdict: CardVerdict | null;
  readonly verificationRequired: boolean;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const acknowledge = useRefusableCommand(cardEnvironment.acknowledgeFlags);
  const decide = useRefusableCommand(cardEnvironment.decide);
  const summary = card.evidence;
  // A verdict for an older commit judges code the card no longer has.
  const verdict =
    props.verdict !== null && summary !== null && props.verdict.headSha === summary.headSha
      ? props.verdict
      : null;
  const review = useMemo(
    () =>
      reviewByCriterion({ cardId: card.id, criteria: card.acceptance.criteria, items: props.items, verdict }),
    [card.id, card.acceptance.criteria, props.items, verdict],
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
      <Group title="Review">
        <Row first>
          <Muted>No evidence yet. Iskra captures it when the agent asks for review or a checkpoint.</Muted>
        </Row>
        {card.status === "inReview" ? (
          <Row>
            <ActionButton
              label="Capture evidence"
              onPress={() =>
                void decide(
                  { environmentId, input: { type: "card.evidence.capture", cardId: card.id } },
                  "Evidence was not requested",
                )
              }
            />
          </Row>
        ) : null}
      </Group>
    );
  }

  const { verification } = card;
  const verifier =
    verification.verifier === null
      ? null
      : props.agents.find((agent) => agent.id === verification.verifier?.agentId);
  const rerunRefusal = rerunVerifierRefusal(card);

  return (
    <>
      {props.verificationRequired ? (
        <Group title="Verifier">
          <Row first>
            <Body strong>{VERIFICATION_TITLE[verification.state]}</Body>
            {verification.verifier !== null ? (
              <Muted>
                @{verifier?.name ?? "verifier"} · {verification.verifier.model}
              </Muted>
            ) : null}
            {verification.override !== null ? (
              <Muted>You overrode it: {verification.override.reason}</Muted>
            ) : null}
            {verification.satisfaction !== null && verification.satisfaction.total > 0 ? (
              <Muted>
                Hidden scenarios {verification.satisfaction.satisfied}/{verification.satisfaction.total} satisfied
              </Muted>
            ) : null}
            <ButtonRow>
              <ActionButton
                label="Rerun verifier"
                disabled={rerunRefusal !== null}
                onPress={() =>
                  void decide(
                    { environmentId, input: { type: "card.verifier.rerun", cardId: card.id } },
                    "The verifier was not rerun",
                  )
                }
              />
            </ButtonRow>
          </Row>
        </Group>
      ) : null}

      <Group
        title="Criteria"
        footer={`${summary.purpose === "checkpoint" ? "Checkpoint evidence" : "Evidence"} for ${summary.headSha.slice(0, 7)} · ${summary.passed ? "passed" : "failed"}`}
      >
        {review.criteria.length === 0 ? (
          <Row first>
            <Muted>This card has no acceptance criteria, so only its checks speak for it.</Muted>
          </Row>
        ) : (
          review.criteria.map((entry, index) => (
            <Row key={entry.criterion.id} first={index === 0}>
              <View className="flex-row items-start gap-3">
                <View className="min-w-0 flex-1">
                  <Body>{entry.criterion.text}</Body>
                </View>
                <StatusPill
                  label={CRITERION_STATE_LABEL[entry.state]}
                  tone={MARK_TONE[markOfCriterionState(entry.state)]}
                />
              </View>
              {entry.verdict !== null && (entry.verdict.note.length > 0 || entry.verdict.evidence.length > 0) ? (
                <Muted>{entry.verdict.note.length > 0 ? entry.verdict.note : entry.verdict.evidence}</Muted>
              ) : null}
              {entry.state === "needsYourCheck" ? (
                <Muted>Check this yourself; automation doesn't cover it.</Muted>
              ) : null}
              {entry.items.map((view) => (
                <EvidenceRow
                  key={view.item.itemId}
                  view={view}
                  exhibit={exhibits.get(view.item.itemId)}
                  environmentId={environmentId}
                />
              ))}
            </Row>
          ))
        )}
      </Group>

      {review.general.length > 0 ? (
        <Group title="Checks">
          {review.general.map((view, index) => (
            <Row key={view.item.itemId} first={index === 0}>
              <EvidenceRow view={view} exhibit={exhibits.get(view.item.itemId)} environmentId={environmentId} />
            </Row>
          ))}
        </Group>
      ) : null}

      {summary.flags.length > 0 ? (
        <Group title="Flagged changes">
          {summary.flags.map((flag, index) => (
            <Row key={`${flag.kind}:${flag.path}`} first={index === 0}>
              <Text style={{ color: flag.hard ? TONE_COLOR.red : TONE_COLOR.gray, fontSize: 13 }}>
                {SCOPE_FLAG_LABEL[flag.kind]}
              </Text>
              <Body>{flag.path}</Body>
              {flag.detail.length > 0 ? <Muted>{flag.detail}</Muted> : null}
            </Row>
          ))}
          {hasUnacknowledgedHardFlags(summary) ? (
            <Row>
              <ActionButton
                label="Acknowledge flagged changes"
                onPress={() =>
                  void acknowledge(
                    { environmentId, input: { cardId: card.id, evidenceId: summary.evidenceId } },
                    "The flags were not acknowledged",
                  )
                }
              />
            </Row>
          ) : null}
        </Group>
      ) : null}
    </>
  );
}

const EvidenceRow = memo(function EvidenceRow(props: {
  readonly view: EvidenceItemView;
  readonly exhibit: number | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const { item, state } = props.view;
  const stateLabel =
    state === "failed" && item.timedOut
      ? "Timed out"
      : state === "failed"
        ? `Exit ${item.exitCode}`
        : state === "pending"
          ? "Waiting for CI"
          : state === "unavailable"
            ? "Not captured"
            : state === "passed"
              ? "Passed"
              : "Captured";
  return (
    <View className="gap-1 rounded-[10px] bg-subtle px-3 py-2">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-[13px] text-foreground" numberOfLines={1}>
          {item.name}
        </Text>
        <Text
          style={{
            fontSize: 13,
            color: state === "failed" ? TONE_COLOR.red : state === "unavailable" ? TONE_COLOR.orange : TONE_COLOR.gray,
          }}
        >
          {stateLabel}
        </Text>
      </View>
      {state === "unavailable" && props.view.unavailableText !== null ? (
        <Muted>{props.view.unavailableText}</Muted>
      ) : null}
      {props.view.artifact !== null ? (
        <EvidenceFile
          resource={props.view.artifact}
          screenshot={item.kind === "screenshot"}
          exhibit={props.exhibit}
          environmentId={props.environmentId}
        />
      ) : null}
      {props.view.log !== null ? (
        <EvidenceFile resource={props.view.log} screenshot={false} environmentId={props.environmentId} />
      ) : null}
    </View>
  );
});

/** A screenshot inline, or a link to a recording or a check's full log, through a signed asset URL. */
function EvidenceFile(props: {
  readonly resource: AssetResource;
  readonly screenshot: boolean;
  readonly exhibit?: number | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const url = useAssetUrlState(props.environmentId, props.resource);
  if (url._tag === "Loading") return <Muted>Loading…</Muted>;
  if (url._tag !== "Success") return <Muted>The file is no longer available.</Muted>;
  const open = () => void Linking.openURL(url.url);
  return props.screenshot ? (
    <Pressable accessibilityRole="imagebutton" onPress={open} className="gap-1">
      <Image
        source={{ uri: url.url }}
        resizeMode="contain"
        style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 8 }}
      />
      {props.exhibit !== undefined ? <Muted>Exhibit {props.exhibit}</Muted> : null}
    </Pressable>
  ) : (
    <Pressable accessibilityRole="link" onPress={open}>
      <Text style={{ color: TONE_COLOR.blue, fontSize: 13 }}>
        {props.resource._tag === "card-check-log" ? "Full log" : "Open the recording"}
      </Text>
    </Pressable>
  );
}

/** Where the card lands: its pull request, CI as the evidence reads it, and fix rounds used. */
export function CardLanding(props: {
  readonly card: OrchestrationCardShell;
  readonly items: ReadonlyArray<CardEvidenceItem>;
  readonly policy: ProjectOrchestration;
  readonly environmentId: EnvironmentId;
}) {
  const { card } = props;
  const decide = useRefusableCommand(cardEnvironment.decide);
  const rounds = fixRoundsView(card.fixRounds, props.policy);
  const ci = useMemo(() => ciSummary(props.items), [props.items]);
  const landing = card.landing;
  const link = card.status === "landed" ? (landing?.mergedOnHostUrl ?? landing?.url ?? null) : (landing?.url ?? null);
  return (
    <Group title="Landing">
      <Row first onPress={link === null ? undefined : () => void Linking.openURL(link)}>
        <Body>
          {landing === null
            ? "Not linked to a pull request yet."
            : landing.mode === "local"
              ? "Lands locally by fast-forwarding the base branch."
              : landing.url !== null
                ? `Pull request${landing.number !== null ? ` #${landing.number}` : ""}${landing.draft ? " · draft" : ""}`
                : "Pull request opening…"}
        </Body>
        {landing?.mode === "pullRequest" ? (
          <Muted>
            {ci.total === 0
              ? "No CI results yet."
              : ci.failed.length > 0
                ? `CI failing: ${ci.failed.join(", ")}`
                : ci.pending.length > 0
                  ? `Waiting for CI: ${ci.pending.join(", ")}`
                  : `CI passed (${ci.total})`}
          </Muted>
        ) : null}
      </Row>
      <Row>
        <Muted>
          CI fixes {rounds.ci.used} of {rounds.ci.cap} · review fixes {rounds.review.used} of {rounds.review.cap}
        </Muted>
        {rounds.exhausted || card.paused?.reason.code === "fixRoundsExhausted" ? (
          <ButtonRow>
            <ActionButton
              label="Give it more rounds"
              onPress={() =>
                void decide(
                  { environmentId: props.environmentId, input: { type: "card.fix-rounds.reset", cardId: card.id } },
                  "The fix rounds were not reset",
                )
              }
            />
          </ButtonRow>
        ) : null}
      </Row>
    </Group>
  );
}
