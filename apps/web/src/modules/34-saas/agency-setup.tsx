// apps/web/src/modules/34-saas — Agency setup: the tenant's provider entity (CMS identity: CCN, NPI, EIN) and its
// service locations. The M34 onboarding checks (`ccn_registered`, `org_seeded`, `locations_seeded`) read exactly
// these M2 rows, and until now nothing in either app created them. Backed by the existing M2 org-admin routes
// GET/POST /api/v1/provider-entities and /api/v1/locations (both gated server-side on `org.manage`).
import {
  Button,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
  useRequestGuard,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { LocationForm } from "./wizard/location-form";
import { ProviderEntityForm } from "./wizard/provider-entity-form";

interface ProviderEntityRow {
  id: string;
  legalName: string;
  ccn: string | null;
  npi: string | null;
  status: string;
}
interface LocationRow {
  id: string;
  providerEntityId: string;
  name: string;
  city: string;
  state: string;
  timezone: string;
  status: string;
}

export function AgencySetup(): JSX.Element {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [entities, setEntities] = useState<ProviderEntityRow[] | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    try {
      const [pe, loc] = await Promise.all([
        client.GET("/api/v1/provider-entities", { params: { query: { limit: 100 } } }),
        client.GET("/api/v1/locations", { params: { query: { limit: 100 } } }),
      ]);
      if (!isCurrent()) return;
      if (pe.error || loc.error || !pe.data || !loc.data) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setEntities(pe.data.items as unknown as ProviderEntityRow[]);
      setLocations(loc.data.items as unknown as LocationRow[]);
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Agency setup">
          <p className="wx-row-sub">
            Register your agency's CMS identity and its service locations. Onboarding cannot finish
            until both exist.
          </p>
        </PageHeader>
      }
      table={
        <div className="wx-page-sections">
          {loadError ? (
            <>
              <InlineAlert tone="error">Could not load your agency details.</InlineAlert>
              <Button tone="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </>
          ) : null}
          {entities === null && !loadError ? <LoadingSpinner label="Loading…" /> : null}
          {/* Render the sections only once the lists are known: "no provider entity yet" on a failed or pending
              load would invite creating a duplicate CCN/NPI. */}
          {entities !== null ? (
            <>
              <ProviderEntitySection entities={entities} onCreated={load} />
              <LocationSection entities={entities} locations={locations} onCreated={load} />
            </>
          ) : null}
        </div>
      }
    />
  );
}

function ProviderEntitySection({
  entities,
  onCreated,
}: { entities: ProviderEntityRow[]; onCreated: () => Promise<void> }): JSX.Element {
  return (
    <section aria-label="Provider entities">
      <h2 className="wx-section-title">Provider entities</h2>
      {entities.length === 0 ? <p>No provider entity yet.</p> : null}
      <ul>
        {entities.map((p) => (
          <li key={p.id}>
            <strong>{p.legalName}</strong> · CCN {p.ccn ?? "—"} · NPI {p.npi ?? "—"} · {p.status}
          </li>
        ))}
      </ul>
      <ProviderEntityForm onCreated={onCreated} />
    </section>
  );
}

function LocationSection({
  entities,
  locations,
  onCreated,
}: {
  entities: ProviderEntityRow[];
  locations: LocationRow[];
  onCreated: () => Promise<void>;
}): JSX.Element {
  const noEntities = entities.length === 0;
  return (
    <section aria-label="Locations">
      <h2 className="wx-section-title">Locations</h2>
      {noEntities ? <p>Add a provider entity first; a location belongs to one.</p> : null}
      {locations.length === 0 && !noEntities ? <p>No location yet.</p> : null}
      <ul>
        {locations.map((l) => (
          <li key={l.id}>
            <strong>{l.name}</strong> · {l.city}, {l.state} · {l.timezone} · {l.status}
          </li>
        ))}
      </ul>
      <LocationForm entities={entities} onCreated={onCreated} />
    </section>
  );
}
