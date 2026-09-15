import type { CardId, CardRelationKind } from "@iskra/contracts";

/** A person's command that one click can take back. */
export type UndoableCommand =
  | { readonly type: "card.pause" | "card.abandon" | "card.unapprove"; readonly cardId: CardId }
  | { readonly type: "card.snooze"; readonly cardId: CardId }
  | {
      readonly type: "card.relation.add";
      readonly cardId: CardId;
      readonly kind: CardRelationKind;
      readonly otherCardId: CardId;
    }
  // A dismissed lesson is gone from the read model; there is nothing to take back.
  | { readonly type: "project.knowledge.dismiss" };

/** The command that takes one back. */
export type UndoCommand =
  | {
      readonly type: "card.resume" | "card.reopen" | "card.approve" | "card.unsnooze";
      readonly cardId: CardId;
    }
  | {
      readonly type: "card.relation.remove";
      readonly cardId: CardId;
      readonly kind: CardRelationKind;
      readonly otherCardId: CardId;
    };

/**
 * The reverse of a command, for an Undo toast, or null when nothing reverses it. The server still
 * judges the reverse: a card that moved on since (a reopened card someone approved) refuses it.
 */
export function undoCommandOf(command: UndoableCommand): UndoCommand | null {
  switch (command.type) {
    case "card.pause":
      return { type: "card.resume", cardId: command.cardId };
    case "card.abandon":
      return { type: "card.reopen", cardId: command.cardId };
    case "card.unapprove":
      return { type: "card.approve", cardId: command.cardId };
    case "card.snooze":
      return { type: "card.unsnooze", cardId: command.cardId };
    case "card.relation.add":
      return {
        type: "card.relation.remove",
        cardId: command.cardId,
        kind: command.kind,
        otherCardId: command.otherCardId,
      };
    case "project.knowledge.dismiss":
      return null;
  }
}

/** What an Undo toast says was done. */
export const UNDOABLE_LABEL: Record<Exclude<UndoableCommand["type"], "project.knowledge.dismiss">, string> =
  {
    "card.pause": "Card paused",
    "card.abandon": "Card abandoned",
    "card.unapprove": "Card sent back to triage",
    "card.snooze": "Card snoozed",
    "card.relation.add": "Relation added",
  };
