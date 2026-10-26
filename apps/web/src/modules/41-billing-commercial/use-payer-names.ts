// apps/web/src/modules/41-billing-commercial — payer display names, read per payer from master data. A name that cannot be read
// is simply absent: callers fall back to a short id and the page never blanks.
//   GET /api/v1/mdm/payer/{id}
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

export function usePayerNames(payerIds: readonly string[]): Readonly<Record<string, string>> {
  const client = useApiClient();
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const wanted = [...new Set(payerIds)].sort().join(",");

  useEffect(() => {
    let active = true;
    for (const id of wanted ? wanted.split(",") : []) {
      void client
        .GET("/api/v1/mdm/{kind}/{id}", { params: { path: { kind: "payer", id } } })
        .then(({ data }) => {
          const name = data?.canonical?.displayName;
          if (active && name) setNames((prev) => ({ ...prev, [id]: name }));
        })
        .catch(() => undefined); // a name that cannot be read falls back to the short id
    }
    return () => {
      active = false;
    };
  }, [client, wanted]);

  return names;
}
