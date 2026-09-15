import { useAtomValue } from "@effect/atom-react";
import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import { subscribe } from "@iskra/client-runtime/rpc";
import { createCardEnvironmentAtoms } from "@iskra/client-runtime/state/cards";
import { createChannelEnvironmentAtoms } from "@iskra/client-runtime/state/channels";
import { enabledEnvironmentIds } from "@iskra/client-runtime/state/connections";
import { createEnvironmentAgentChannelAtoms } from "@iskra/client-runtime/state/projects";
import {
  createEnvironmentCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@iskra/client-runtime/state/runtime";
import {
  ORCHESTRATION_WS_METHODS,
  type CardActivity,
  type CardId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationCardStreamItem,
  type OrchestrationChannelShell,
  type OrchestrationProjectShell,
} from "@iskra/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentProjects } from "../../state/projects";
import { environmentSnapshotAtom } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export const cardEnvironment = createCardEnvironmentAtoms(connectionAtomRuntime);
export const channelEnvironment = createChannelEnvironmentAtoms(connectionAtomRuntime);
export const environmentAgentChannels = createEnvironmentAgentChannelAtoms({
  snapshotAtom: environmentSnapshotAtom,
});
type CardActivityPage = Extract<OrchestrationCardStreamItem, { readonly kind: "page" }>;

// ponytail: mirrors client-runtime `loadOlderCardActivity` and the reducer's page merge, because
// `@iskra/client-runtime/state/cardActivity` is not a package export yet; import both once it is.
/** One older page of a card's activity: subscribeCard with `before` sends one page and ends. */
export const olderCardActivity = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:cards:activity-page",
  execute: (input: { readonly cardId: CardId; readonly before: string }) =>
    subscribe(ORCHESTRATION_WS_METHODS.subscribeCard, input).pipe(
      Stream.filter((item): item is CardActivityPage => item.kind === "page"),
      Stream.runHead,
      Effect.map(
        Option.getOrElse((): CardActivityPage => ({ kind: "page", activities: [], hasMore: false })),
      ),
    ),
});

/** Older pages (oldest first) before the live activities, keeping the live copy of any repeat. */
export function withOlderActivities(
  older: ReadonlyArray<CardActivity>,
  live: ReadonlyArray<CardActivity>,
): ReadonlyArray<CardActivity> {
  if (older.length === 0) return live;
  const held = new Set(live.map((activity) => activity.activityId));
  return [...older.filter((activity) => !held.has(activity.activityId)), ...live];
}

const EMPTY_LIST_ATOM = Atom.make<ReadonlyArray<never>>([]).pipe(
  Atom.withLabel("mobile-iskra-list:empty"),
);

function useEnvironmentList<A>(
  environmentId: EnvironmentId | null,
  family: (environmentId: EnvironmentId) => Atom.Atom<ReadonlyArray<A>>,
): ReadonlyArray<A> {
  return useAtomValue(environmentId === null ? EMPTY_LIST_ATOM : family(environmentId));
}

export const useEnvironmentCards = (environmentId: EnvironmentId | null) =>
  useEnvironmentList<OrchestrationCardShell>(
    environmentId,
    environmentAgentChannels.environmentCardsAtom,
  );
export const useEnvironmentAgents = (environmentId: EnvironmentId | null) =>
  useEnvironmentList<OrchestrationAgentShell>(
    environmentId,
    environmentAgentChannels.environmentAgentsAtom,
  );
export const useEnvironmentChannels = (environmentId: EnvironmentId | null) =>
  useEnvironmentList<OrchestrationChannelShell>(
    environmentId,
    environmentAgentChannels.environmentChannelsAtom,
  );

/** Every enabled environment's cards and projects, which Needs you reads across environments. */
export interface EnvironmentCards {
  readonly environmentId: EnvironmentId;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}

let previousEnvironmentCards: ReadonlyArray<EnvironmentCards> = [];
const environmentCardsAtom = Atom.make((get): ReadonlyArray<EnvironmentCards> => {
  const next = [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].map(
    (environmentId) => ({
      environmentId,
      cards: get(environmentAgentChannels.environmentCardsAtom(environmentId)),
      projects: get(environmentProjects.environmentProjectsAtom(environmentId)),
    }),
  );
  // Keep the same array while nothing it holds changed, so readers don't recompute Needs you.
  const same =
    next.length === previousEnvironmentCards.length &&
    next.every((entry, index) => {
      const previous = previousEnvironmentCards[index];
      return (
        previous !== undefined &&
        previous.environmentId === entry.environmentId &&
        previous.cards === entry.cards &&
        previous.projects === entry.projects
      );
    });
  if (!same) previousEnvironmentCards = next;
  return previousEnvironmentCards;
}).pipe(Atom.withLabel("mobile-iskra-environment-cards"));

/** A clock that ticks each minute: waiting times and snoozes read in minutes, never animated. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/** Needs you across every enabled environment, longest waiting first within each. */
export function useNeedsYou(now: number) {
  const environments = useAtomValue(environmentCardsAtom);
  return useMemo(
    () =>
      environments.map((entry) => ({
        ...entry,
        items: needsYouItems({
          cards: entry.cards,
          sessions: cardOwnerSessions(entry.cards),
          projects: entry.projects,
          now,
        }),
      })),
    [environments, now],
  );
}

/** How many things wait on a person across environments, for the Home header. */
export function useNeedsYouCount(): number {
  const environments = useNeedsYou(useMinuteClock());
  return environments.reduce((sum, entry) => sum + entry.items.length, 0);
}

/**
 * A command that says a refusal in a native alert, with the server's reason. Resolves true once
 * the server accepted it.
 */
export function useRefusableCommand<W, A, E>(command: AtomCommand<W, A, E>) {
  const run = useAtomCommand(command);
  return useCallback(
    async (value: W, failure: string): Promise<boolean> => {
      const result = await run(value);
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          failure,
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The request was refused.",
        );
      }
      return false;
    },
    [run],
  );
}
