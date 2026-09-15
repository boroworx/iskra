import { ORCHESTRATION_WS_METHODS } from "@iskra/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  acknowledgeCardFlags,
  addCardRelation,
  answerCardElicitation,
  approveAndStartCard,
  approveCardPlan,
  assignCard,
  commentOnCardReview,
  createCard,
  decideCard,
  dismissCardAttention,
  forwardCardComment,
  keepCardRefs,
  overrideCardVerifier,
  postCardMessage,
  removeCardRelation,
  restoreCardCheckpoint,
  restoreCardRefs,
  revertCard,
  setCardBudget,
  setCardCriteria,
  setCardOutcome,
  setProjectOrchestration,
  startCardAttempts,
  snoozeCard,
  unsnoozeCard,
  updateCard,
} from "../operations/commands.ts";
import type { UndoCommand } from "../undo.ts";
import { createCardActivityAtomFamily } from "./cardActivity.ts";
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Sends an Undo toast's reverse command through the command that carries it. */
const undoCard = (command: UndoCommand) => {
  switch (command.type) {
    case "card.unsnooze":
      return unsnoozeCard({ cardId: command.cardId });
    case "card.relation.remove":
      return removeCardRelation({
        cardId: command.cardId,
        kind: command.kind,
        otherCardId: command.otherCardId,
      });
    default:
      return decideCard({ type: command.type, cardId: command.cardId });
  }
};

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
    restoreRefs: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:restore-refs",
      execute: restoreCardRefs,
    }),
    keepRefs: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:keep-refs",
      execute: keepCardRefs,
    }),
    forwardComment: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:forward-comment",
      execute: forwardCardComment,
    }),
    overrideVerifier: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:override-verifier",
      execute: overrideCardVerifier,
    }),
    dismissAttention: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:dismiss-attention",
      execute: dismissCardAttention,
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
    approvePlan: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:approve-plan",
      execute: approveCardPlan,
    }),
    setOutcome: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:set-outcome",
      execute: setCardOutcome,
    }),
    revert: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:revert",
      execute: revertCard,
    }),
    restoreCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:restore-checkpoint",
      execute: restoreCardCheckpoint,
    }),
    /** The reverse command an Undo toast sends; see `undoCommandOf`. */
    undo: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:card:undo",
      execute: undoCard,
    }),
  };
}
