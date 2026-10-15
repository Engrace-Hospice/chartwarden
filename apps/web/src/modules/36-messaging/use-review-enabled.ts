// M36 WP 3.8 - whether the viewer's Review tab exists. The review list route answers `{enabled:false,items:[]}` while the
// tenant has tasks off, and 403/404 when the viewer lacks the permission, so `enabled:true` is the ONLY signal that shows
// the tab (useFeatureFlag is never loaded in the real app). Read ONCE per API client; every other answer fails closed to
// hidden (a failure is not cached, so a later mount tries again; an "off" answer is). The server stays the authority.
import type { ApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

const sharedReads = new WeakMap<ApiClient, Promise<boolean>>();

function readReviewEnabled(client: ApiClient): Promise<boolean> {
  const cached = sharedReads.get(client);
  if (cached) return cached;
  const forget = (): false => {
    sharedReads.delete(client);
    return false;
  };
  // Deferred a tick so a client that throws (not just rejects) also fails closed.
  const read = Promise.resolve()
    .then(() =>
      client.GET("/api/v1/messaging/review-items", { params: { query: { state: "open" } } }),
    )
    .then((result) => (result?.data ? result.data.enabled === true : forget()), forget);
  sharedReads.set(client, read);
  return read;
}

export function useReviewEnabled(): boolean {
  const client = useOptionalApiClient();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!client) return;
    let current = true;
    void readReviewEnabled(client).then((value) => {
      if (current) setEnabled(value);
    });
    return () => {
      current = false;
    };
  }, [client]);
  return enabled;
}
