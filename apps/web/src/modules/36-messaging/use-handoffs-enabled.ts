// M36 WP 3.5 - whether the tenant has handoffs turned on. The handoffs list route answers `{enabled:false,handoffs:[]}`
// when the flag is off, so that is the signal (useFeatureFlag is never loaded in the real app). Read ONCE per API client
// and fail closed on any error (a failure is not cached, so a later mount tries again; an "off" answer is). The server
// stays the authority: with the flag off its handoff routes answer 404.
import { type ApiClient, useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";

const sharedReads = new WeakMap<ApiClient, Promise<boolean>>();

function readHandoffsEnabled(client: ApiClient): Promise<boolean> {
  const cached = sharedReads.get(client);
  if (cached) return cached;
  const forget = (): false => {
    sharedReads.delete(client);
    return false;
  };
  // Deferred a tick so a client that throws (not just rejects) also fails closed.
  const read = Promise.resolve()
    .then(() =>
      client.GET("/api/v1/messaging/handoffs", {
        params: { query: { scope: "incoming", state: "active" } },
      }),
    )
    .then((result) => (result?.data ? result.data.enabled === true : forget()), forget);
  sharedReads.set(client, read);
  return read;
}

/** No client mounted reads as OFF. */
function useOptionalApiClient(): ApiClient | null {
  try {
    return useApiClient();
  } catch {
    return null;
  }
}

export function useHandoffsEnabled(): boolean {
  const client = useOptionalApiClient();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!client) return;
    let current = true;
    void readHandoffsEnabled(client).then((value) => {
      if (current) setEnabled(value);
    });
    return () => {
      current = false;
    };
  }, [client]);
  return enabled;
}
