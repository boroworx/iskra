import { routeAgentNotificationResponseOnce } from "../agent-awareness/notificationPayload";

/**
 * Opens what a tapped notification names, once per notification: its card when it names one,
 * otherwise its agent thread.
 */
export function routeNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const cardLink = extractCardNotificationDeepLink(input.response);
  if (cardLink === null) {
    routeAgentNotificationResponseOnce(input);
    return;
  }
  const identifier = (
    input.response as { readonly notification?: { readonly request?: { readonly identifier?: unknown } } } | null
  )?.notification?.request?.identifier;
  if (typeof identifier === "string") {
    if (input.handledResponseIds.has(identifier)) return;
    input.handledResponseIds.add(identifier);
  }
  input.navigate(cardLink);
}

/** The app route for one card: `/cards/<environmentId>/<cardId>`. */
export function cardDeepLink(input: {
  readonly environmentId: string;
  readonly cardId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.cardId.length === 0) return null;
  return `/cards/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.cardId)}`;
}

function notificationData(response: unknown): Record<string, unknown> | null {
  const data = (
    response as
      | { readonly notification?: { readonly request?: { readonly content?: { readonly data?: unknown } } } }
      | null
      | undefined
  )?.notification?.request?.content?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/**
 * The card a notification opens: an explicit `/cards/<env>/<card>` deep link, normalized, or
 * `environmentId` and `cardId` in its data. Null for anything else, so thread routing applies.
 */
export function extractCardNotificationDeepLink(response: unknown): string | null {
  const data = notificationData(response);
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string" && !/[?#\s]/.test(deepLink)) {
    const parts = deepLink.split("/");
    if (parts.length === 4 && parts[0] === "" && parts[1] === "cards") {
      try {
        const link = cardDeepLink({
          environmentId: decodeURIComponent(parts[2] ?? ""),
          cardId: decodeURIComponent(parts[3] ?? ""),
        });
        if (link !== null) return link;
      } catch {
        // A malformed escape falls through to the ids.
      }
    }
  }
  const { environmentId, cardId } = data ?? {};
  return typeof environmentId === "string" && typeof cardId === "string"
    ? cardDeepLink({ environmentId, cardId })
    : null;
}
