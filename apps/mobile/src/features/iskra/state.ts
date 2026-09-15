import { useAtomValue } from "@effect/atom-react";
import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import { loadOlderCardActivity } from "@iskra/client-runtime/state/card-activity";
import { createCardEnvironmentAtoms } from "@iskra/client-runtime/state/cards";
import { createChannelEnvironmentAtoms } from "@iskra/client-runtime/state/channels";
import { enabledEnvironmentIds } from "@iskra/client-runtime/state/connections";
import { createEnvironmentAgentChannelAtoms } from "@iskra/client-runtime/state/projects";
import {
  createEnvironmentCommand,
  isAtomCommandInterrupted,
  atomCommandFailureMessage,
  type AtomCommand,
} from "@iskra/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationChannelShell,
  type OrchestrationProjectShell,
} from "@iskra/contracts";
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

/** One older page of a card's activity: subscribeCard with `before` sends one page and ends. */
export const olderCardActivity = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:cards:activity-page",
  execute: loadOlderCardActivity,
});

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
        Alert.alert(failure, atomCommandFailureMessage(result, "The request was refused."));
      }
      return false;
    },
    [run],
  );
}
