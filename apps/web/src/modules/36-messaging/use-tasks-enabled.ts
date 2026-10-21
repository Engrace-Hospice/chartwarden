// M36 WP 3.4 - whether the tenant has tasks turned on. The tasks list route answers `{enabled:false,tasks:[]}` when the
// flag is off, so that is the signal: it is read ONCE per API client (every message row shares the same answer) and
// fails closed on any error (a failure is not cached, so a later mount tries again; an "off" answer is). The server
// stays the authority: with the flag off its task routes answer 404, so a stale "on" here only shows a trigger that then fails politely.
import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

const sharedReads = new WeakMap<ApiClient, Promise<boolean>>();

function readTasksEnabled(client: ApiClient): Promise<boolean> {
  const cached = sharedReads.get(client);
  if (cached) return cached;
  const forget = (): false => {
    sharedReads.delete(client);
    return false;
  };
  // Deferred a tick so a client that throws (not just rejects) also fails closed.
  const read = Promise.resolve()
    .then(() =>
      client.GET("/api/v1/messaging/tasks", {
        params: { query: { scope: "assigned", state: "active" } },
      }),
    )
    .then((result) => (result?.data ? result.data.enabled === true : forget()), forget);
  sharedReads.set(client, read);
  return read;
}

/** No client mounted (a bare row in a test or story) reads as OFF. */
function useOptionalApiClient(): ApiClient | null {
  try {
    return useApiClient();
  } catch {
    return null;
  }
}

export function useTasksEnabled(): boolean {
  const client = useOptionalApiClient();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!client) return;
    let current = true;
    void readTasksEnabled(client).then((value) => {
      if (current) setEnabled(value);
    });
    return () => {
      current = false;
    };
  }, [client]);
  return enabled;
}
