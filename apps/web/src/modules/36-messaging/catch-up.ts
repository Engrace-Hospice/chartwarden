// WP 5.2: after a reconnect the newest page may not reach back to what the client already holds. Page backward with the
// server's opaque cursor until a page overlaps a known id; if the page budget runs out first, say so (never guess).
import { BACKGROUND_REQUEST_HEADERS, type useApiClient } from "@chartwarden/ui";
import type { Message } from "./messaging-types";

export const CATCH_UP_MAX_PAGES = 5;

export interface CatchUpPage {
  readonly messages: readonly Message[];
  readonly nextCursor: string | null;
}

export interface CatchUpResult {
  readonly messages: readonly Message[];
  /** True when the page budget (or a failed read) stopped the walk before it met a known message. */
  readonly gap: boolean;
}

const overlaps = (page: readonly Message[], known: ReadonlySet<string>): boolean =>
  page.some((message) => known.has(message.messageId));

/** True when `firstPage` leaves a hole between itself and what is already loaded. */
export function needsCatchUp(
  known: readonly Message[] | null,
  firstPage: readonly Message[],
): boolean {
  if (!known || known.length === 0 || firstPage.length === 0) return false;
  const ids = new Set(known.map((message) => message.messageId));
  return !overlaps(firstPage, ids);
}

/** `fetchOlderPage` returns null on a failed read. `firstPage` counts toward `maxPages`. */
export async function catchUp(
  fetchOlderPage: (cursor: string) => Promise<CatchUpPage | null>,
  knownIds: ReadonlySet<string>,
  firstPage: CatchUpPage,
  maxPages = CATCH_UP_MAX_PAGES,
): Promise<CatchUpResult> {
  let messages: readonly Message[] = firstPage.messages;
  let cursor = firstPage.nextCursor;
  let pages = 1;
  let reached = overlaps(firstPage.messages, knownIds);
  while (!reached && cursor !== null && pages < maxPages) {
    const page = await fetchOlderPage(cursor);
    if (!page) return { messages, gap: true };
    pages += 1;
    messages = [...messages, ...page.messages];
    cursor = page.nextCursor;
    reached = overlaps(page.messages, knownIds);
  }
  // No cursor left means the start of the conversation: nothing older exists, so nothing is missing.
  return { messages, gap: !reached && cursor !== null };
}

/** The thread's catch-up read: background-tagged older pages of one channel. Null when the first page already overlaps. */
export async function catchUpIfNeeded(
  client: ReturnType<typeof useApiClient>,
  channelId: string,
  known: readonly Message[] | null,
  data: { messages?: unknown; nextCursor?: unknown } | undefined,
): Promise<CatchUpResult | null> {
  const firstMessages = (data?.messages ?? []) as Message[];
  if (!known || !needsCatchUp(known, firstMessages)) return null;
  return catchUp(
    async (cursor) => {
      const { data: page, error } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
        params: { path: { id: channelId }, query: { limit: 50, direction: "backward", cursor } },
        headers: BACKGROUND_REQUEST_HEADERS,
      });
      if (error || !page) return null;
      return {
        messages: page.messages as Message[],
        nextCursor: (page.nextCursor as string | undefined) ?? null,
      };
    },
    new Set(known.map((message) => message.messageId)),
    { messages: firstMessages, nextCursor: (data?.nextCursor as string | undefined) ?? null },
  );
}
