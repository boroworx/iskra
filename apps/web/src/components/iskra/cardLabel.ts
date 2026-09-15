/** A card's short caption id: its Linear identifier when synced, else `C-` and its id's first four characters. */
export function cardShortId(card: {
  readonly id: string;
  readonly linearIssue: { readonly identifier: string } | null;
}): string {
  return card.linearIssue?.identifier ?? `C-${card.id.slice(0, 4).toUpperCase()}`;
}
