import { ORCHESTRATION_WS_METHODS } from "@iskra/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  acknowledgeCardFlags,
  addCardRelation,
  answerCardElicitation,
  approveAndStartCard,
  assignCard,
  commentOnCardReview,
  createCard,
  decideCard,
  postCardMessage,
  removeCardRelation,
  setCardBudget,
  setCardCriteria,
  setProjectOrchestration,
  startCardAttempts,
  snoozeCard,
  unsnoozeCard,
  updateCard,
} from "../operations/commands.ts";
import { createCardActivityAtomFamily } from "./cardActivity.ts";
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** A person's commands on cards: the board's decisions and Needs you snoozes. */
export function createCardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    activity: createCardActivityAtomFamily(runtime),
    setCriteria: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:set-criteria",
      execute: setCardCriteria,
    }),
    answerElicitation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:answer-elicitation",
      execute: answerCardElicitation,
    }),
    acknowledgeFlags: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:acknowledge-flags",
      execute: acknowledgeCardFlags,
    }),
    setOrchestration: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:set-orchestration",
      execute: setProjectOrchestration,
    }),
    decide: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:decide",
      execute: decideCard,
    }),
    startAttempts: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:start-attempts",
      execute: startCardAttempts,
    }),
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:cards:diff",
      tag: ORCHESTRATION_WS_METHODS.getCardDiff,
    }),
    setBudget: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:set-budget",
      execute: setCardBudget,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:snooze",
      execute: snoozeCard,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:update",
      execute: updateCard,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:unsnooze",
      execute: unsnoozeCard,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:create",
      execute: createCard,
    }),
    assign: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:assign",
      execute: assignCard,
    }),
    approveAndStart: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:approve-and-start",
      execute: approveAndStartCard,
    }),
    postMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:post-message",
      execute: postCardMessage,
    }),
    reviewComment: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:review-comment",
      execute: commentOnCardReview,
    }),
    addRelation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:add-relation",
      execute: addCardRelation,
    }),
    removeRelation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:remove-relation",
      execute: removeCardRelation,
    }),
  };
}
