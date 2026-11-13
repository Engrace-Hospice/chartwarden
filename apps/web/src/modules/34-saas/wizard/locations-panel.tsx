// apps/web/src/modules/34-saas/wizard — step 6, Locations: the service locations of your organization. The administrator adds them here
// (the same M2 route as Agency setup); the step settles by itself once a primary location exists, else it is marked done with evidence.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  LoadingSpinner,
  PendingAttestationWarning,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import type { JSX } from "react";
import { statusLabel } from "../saas-status";
import { LocationForm } from "./location-form";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

type Entities =
  operations["getApiV1Providerentities"]["responses"][200]["content"]["application/json"];
type Locations = operations["getApiV1Locations"]["responses"][200]["content"]["application/json"];

const LIST_LIMIT = 100;

export function LocationsPanel({ step, view, held, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const mayManage = held.has(ONBOARDING_KEYS.orgManage);
  const lists = useLoad<{ entities: Entities; locations: Locations }>(
    `locations:${mayManage}`,
    async () => {
      if (!mayManage) {
        return {
          data: {
            entities: { items: [], nextCursor: null },
            locations: { items: [], nextCursor: null },
          },
        };
      }
      const [entities, locations] = await Promise.all([
        client.GET("/api/v1/provider-entities", { params: { query: { limit: LIST_LIMIT } } }),
        client.GET("/api/v1/locations", { params: { query: { limit: LIST_LIMIT } } }),
      ]);
      if (entities.error !== undefined || entities.data === undefined) return entities;
      if (locations.error !== undefined || locations.data === undefined) return locations;
      return {
        data: { entities: entities.data, locations: locations.data },
        response: locations.response,
      };
    },
    WIZARD_ERROR_COPY,
  );
  const entities = lists.data?.entities.items ?? [];
  const locations = lists.data?.locations.items ?? [];
  const canWrite = mayManage && isStepOpenForWork(view, step);

  const facts: Fact[] = [
    {
      key: "one",
      label: "At least one service location",
      state: locations.length > 0 ? "ok" : "pending",
    },
  ];

  return (
    <>
      <section className="wx-drawer-card" aria-label="Locations">
        <div className="wx-drawer-card-head">
          <h3>Locations</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {!mayManage ? <RoleCannot what="see or add locations" /> : null}
        {lists.failure ? (
          <div className="wx-form-stack">
            <InlineAlert tone="error">Could not load your locations.</InlineAlert>
            <div>
              <Button tone="secondary" size="sm" onClick={() => void lists.reload()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        {lists.loading && !lists.data && !lists.failure ? (
          <LoadingSpinner label="Loading locations…" />
        ) : null}
        {mayManage && lists.data && locations.length === 0 ? <p>No location yet.</p> : null}
        {locations.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Locations</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">City</th>
                <th scope="col">State</th>
                <th scope="col">Time zone</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.city}</td>
                  <td>{l.state}</td>
                  <td>{l.timezone}</td>
                  <td>{statusLabel(l.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {canWrite && lists.data ? (
        <section className="wx-drawer-card" aria-label="Add a location">
          <div className="wx-drawer-card-head">
            <h3>Add a location</h3>
          </div>
          <PendingAttestationWarning view={view} audience="tenant" />
          {entities.length === 0 ? (
            <p>Add a provider entity first (step 5); a location belongs to one.</p>
          ) : null}
          <LocationForm
            entities={entities}
            onCreated={async () => {
              await Promise.all([lists.reload(true), onChanged()]);
            }}
            onViewMoved={async () => onChanged()}
          />
        </section>
      ) : null}
    </>
  );
}
