import { EntityLookupField, useApiClient } from "@wardenx/ui";
import type {
  EntityLookupFieldProps,
  EntityLookupLoadInput,
  EntityLookupLoadResult,
} from "@wardenx/ui";
import { useCallback } from "react";
import type { JSX } from "react";

type Props = Omit<EntityLookupFieldProps, "loadOptions">;

export function OrderAdmissionLookup(props: Props & { patientId: string }): JSX.Element {
  const client = useApiClient();
  const loadOptions = useCallback(
    async (input: EntityLookupLoadInput): Promise<EntityLookupLoadResult> => {
      const { data, error } = await client.GET("/api/v1/admissions", {
        params: { query: { patientId: props.patientId, limit: input.limit } },
      } as never);
      if (error) throw error;
      return {
        options: ((data as { items?: Array<{ id: string; state: string }> })?.items ?? []).map(
          (x) => ({
            id: x.id,
            label: `Admission ${x.id.slice(0, 8)}`,
            searchLabel:`Admission ${x.id.slice(0, 5)}...`,
            description: x.state,
          }),
        ),
        nextCursor: null,
      };
    },
    [client, props.patientId],
  );
  return (
    <EntityLookupField {...props} loadOptions={loadOptions} placeholder="Search admission..." />
  );
}

export function OrderingPhysicianLookup(props: Props): JSX.Element {
  const client = useApiClient();
  const loadOptions = useCallback(
    async (input: EntityLookupLoadInput): Promise<EntityLookupLoadResult> => {
      const { data, error } = await client.GET("/api/v1/mdm/{kind}/search", {
        params: { path: { kind: "physician" }, query: { q: input.query, limit: input.limit } },
      });
      if (error) throw error;
      return {
        options: (data?.results ?? []).map((x) => ({
          id: x.id,
          label: x.canonical.displayName,
          searchLabel: x.canonical.displayName,
          description: x.canonical.identifierValue ?? undefined,
        })),
        nextCursor: null,
      };
    },
    [client],
  );
  return (
    <EntityLookupField {...props} loadOptions={loadOptions} placeholder="Search physician..." />
  );
}
