import { cardShortId as shortIdOf } from "@iskra/client-runtime/card-face";

/** A card's caption id: its Linear identifier when synced, else Iskra's short id (`C-7D20`). */
export function cardShortId(card: {
  readonly id: string;
  readonly linearIssue: { readonly identifier: string } | null;
}): string {
  return card.linearIssue?.identifier ?? shortIdOf(card.id);
}
