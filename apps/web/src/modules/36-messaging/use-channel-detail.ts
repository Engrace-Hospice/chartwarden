// M36 - ONE shared read of the channel detail (GET /api/v1/messaging/channels/{id}) per client and channel. Two things in an open thread need it: the
// presence hook (member display names) and the external-partner banner (WP 6.6, ADR-0096 D18). Each used to issue its own request, so opening a thread
// cost two. Callers now go through here: a read that is in flight, or finished less than FRESH_MS ago, is SHARED instead of repeated. A failed read is
// forgotten at once so the next caller retries. The result never rejects: callers branch on `failed` (the request threw) and `status`.
import { type ApiClient, BACKGROUND_REQUEST_HEADERS } from "@chartwarden/ui";

/** A read newer than this is reused (covers the presence hook and the banner mounting in the same render). A poll a minute later is fresh. */
export const CHANNEL_DETAIL_FRESH_MS = 5_000;

export interface ChannelDetailRead {
  /** The response body when there was one. */
  readonly data: unknown;
  /** The HTTP status when a response arrived; undefined when the request itself failed. */
  readonly status: number | undefined;
  /** True when the request threw (offline, aborted): nothing is known about the channel. */
  readonly failed: boolean;
}

interface Entry {
  readonly at: number;
  readonly promise: Promise<ChannelDetailRead>;
}

const cache = new WeakMap<ApiClient, Map<string, Entry>>();

export function readChannelDetail(
  client: ApiClient,
  channelId: string,
): Promise<ChannelDetailRead> {
  let perClient = cache.get(client);
  if (!perClient) {
    perClient = new Map();
    cache.set(client, perClient);
  }
  const existing = perClient.get(channelId);
  if (existing && Date.now() - existing.at < CHANNEL_DETAIL_FRESH_MS) return existing.promise;
  const entries = perClient;
  const promise: Promise<ChannelDetailRead> = Promise.resolve()
    .then(() =>
      client.GET("/api/v1/messaging/channels/{id}", {
        params: { path: { id: channelId } },
        headers: BACKGROUND_REQUEST_HEADERS,
      }),
    )
    .then(
      (reply): ChannelDetailRead => ({
        data: reply?.data,
        status: reply?.response?.status,
        failed: false,
      }),
      (): ChannelDetailRead => {
        if (entries.get(channelId)?.promise === promise) entries.delete(channelId);
        return { data: undefined, status: undefined, failed: true };
      },
    );
  entries.set(channelId, { at: Date.now(), promise });
  return promise;
}
