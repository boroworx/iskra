import {
  ORCHESTRATION_WS_METHODS,
  type CardActivity,
  type CardEvidenceItem,
  type CardId,
  type CardVerdict,
  type OrchestrationCardStreamItem,
} from "@iskra/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface CardActivityState {
  /** Oldest first. The subscription starts from the newest 200; `loadOlderCardActivity` pages further. */
  readonly activities: ReadonlyArray<CardActivity>;
  /** Whether older activities than the first one held exist on the server. */
  readonly hasMore: boolean;
  /** The items of the card's latest evidence recording. */
  readonly evidence: {
    readonly evidenceId: string;
    readonly items: ReadonlyArray<CardEvidenceItem>;
  } | null;
  /** The card's latest verdict, once a verifier recorded one. */
  readonly verdict: CardVerdict | null;
}

export const EMPTY_CARD_ACTIVITY: CardActivityState = {
  activities: [],
  hasMore: false,
  evidence: null,
  verdict: null,
};

type CardActivityPage = Extract<OrchestrationCardStreamItem, { readonly kind: "page" }>;

/**
 * The page of a card's activities older than `before` (an activity id): the card subscription
 * sends one page and ends. Apply it to the live state with `applyCardStreamItem`, oldest page last.
 */
export function loadOlderCardActivity(input: { readonly cardId: CardId; readonly before: string }) {
  return subscribe(ORCHESTRATION_WS_METHODS.subscribeCard, input).pipe(
    Stream.filter((item): item is CardActivityPage => item.kind === "page"),
    Stream.runHead,
    Effect.map(
      Option.getOrElse((): CardActivityPage => ({ kind: "page", activities: [], hasMore: false })),
    ),
  );
}

/**
 * A card's activity after one stream item. A snapshot replaces everything, so a resubscription
 * starts clean; an activity can arrive in both the snapshot and live, and the later copy replaces
 * the one held; a delivery updates its activity; a new evidence recording or verdict replaces the last.
 */
export function applyCardStreamItem(
  state: CardActivityState,
  item: OrchestrationCardStreamItem,
): CardActivityState {
  switch (item.kind) {
    case "snapshot":
      return {
        activities: item.activities,
        hasMore: item.hasMore ?? false,
        evidence: item.evidence,
        verdict: item.verdict ?? null,
      };
    // An older page goes before what is held, skipping any activity already held.
    case "page": {
      const held = new Set(state.activities.map((activity) => activity.activityId));
      return {
        ...state,
        hasMore: item.hasMore,
        activities: [
          ...item.activities.filter((activity) => !held.has(activity.activityId)),
          ...state.activities,
        ],
      };
    }
    case "activity": {
      const index = state.activities.findIndex(
        (activity) => activity.activityId === item.activity.activityId,
      );
      if (index === -1) {
        return { ...state, activities: [...state.activities, item.activity] };
      }
      const activities = [...state.activities];
      activities[index] = item.activity;
      return { ...state, activities };
    }
    case "delivery":
      return {
        ...state,
        activities: state.activities.map((activity) =>
          activity.activityId === item.activityId
            ? { ...activity, delivery: item.delivery }
            : activity,
        ),
      };
    case "evidence":
      return { ...state, evidence: { evidenceId: item.evidenceId, items: item.items } };
    case "verdict":
      return { ...state, verdict: item.verdict };
  }
}

/** A card's live activity; mounted only while a card sheet or card screen reads it. */
export function createCardActivityAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:cards:activity",
    // Closing the sheet drops the stream soon after, not after the default five minutes.
    idleTtlMs: 5_000,
    subscribe: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.subscribeCard>) =>
      subscribe(ORCHESTRATION_WS_METHODS.subscribeCard, input).pipe(
        Stream.mapAccum(
          () => EMPTY_CARD_ACTIVITY,
          (current, item) => {
            const next = applyCardStreamItem(current, item);
            return [next, [next]] as const;
          },
        ),
      ),
  });
}
