import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CardDecisionInput,
  type SetCardBudgetInput,
  type SnoozeCardInput,
  type UnsnoozeCardInput,
  decideCard,
  setCardBudget,
  snoozeCard,
  unsnoozeCard,
} from "../operations/commands.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export type {
  CardDecisionInput,
  SetCardBudgetInput,
  SnoozeCardInput,
  UnsnoozeCardInput,
} from "../operations/commands.ts";

/** A person's commands on cards: the board's decisions and Needs you snoozes. */
export function createCardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    decide: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:decide",
      execute: (input: CardDecisionInput) => decideCard(input),
    }),
    setBudget: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:set-budget",
      execute: (input: SetCardBudgetInput) => setCardBudget(input),
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:snooze",
      execute: (input: SnoozeCardInput) => snoozeCard(input),
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:unsnooze",
      execute: (input: UnsnoozeCardInput) => unsnoozeCard(input),
    }),
  };
}
