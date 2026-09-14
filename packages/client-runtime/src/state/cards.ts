import { ORCHESTRATION_WS_METHODS } from "@iskra/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type CardDecisionInput,
  type SetCardBudgetInput,
  type StartCardAttemptsInput,
  type SnoozeCardInput,
  type UnsnoozeCardInput,
  type UpdateCardInput,
  decideCard,
  setCardBudget,
  startCardAttempts,
  snoozeCard,
  unsnoozeCard,
  updateCard,
} from "../operations/commands.ts";
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export type {
  CardDecisionInput,
  SetCardBudgetInput,
  SnoozeCardInput,
  StartCardAttemptsInput,
  UnsnoozeCardInput,
  UpdateCardInput,
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
    startAttempts: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:start-attempts",
      execute: (input: StartCardAttemptsInput) => startCardAttempts(input),
    }),
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:cards:diff",
      tag: ORCHESTRATION_WS_METHODS.getCardDiff,
    }),
    setBudget: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:set-budget",
      execute: (input: SetCardBudgetInput) => setCardBudget(input),
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:snooze",
      execute: (input: SnoozeCardInput) => snoozeCard(input),
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:update",
      execute: (input: UpdateCardInput) => updateCard(input),
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:unsnooze",
      execute: (input: UnsnoozeCardInput) => unsnoozeCard(input),
    }),
  };
}
