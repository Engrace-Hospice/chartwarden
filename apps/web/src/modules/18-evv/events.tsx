// apps/web/src/modules/18-evv — EVV Event Ledger (M18 §5.1 `/app/evv/events`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". A searchable, caseload-scoped capture ledger: one row per
// `evv_event` with its kind / clinician / gps-quality. Coordinates are NEVER shown here (D10 — evv.read_coords
// is a separate path). Row click opens the §5.1 event detail. Filters (clinician / patient / kind) are passed
// to the server as query params; the SERVER owns the §4.7 ABAC + RLS narrowing (ADR-0030 — no frontend authz;
// out-of-scope events 404, never 403). Reads GET /api/v1/evv/events via the typed client. Leaves only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { DataTable, EVV_QUALITY_COLOR, StatusChip, ts } from "./evv-shared";

interface EvvEventRow {
  id: string;
  visitId: string;
  patientId: string;
  kind: string;
  postingMembershipId: string;
  capturedAt: string;
  gpsQuality: string;
}

export function EvvEvents(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clinician = params.get("clinician") ?? undefined;
  const patient = params.get("patient") ?? undefined;
  const visit = params.get("visit") ?? undefined;
  const [events, setEvents] = useState<EvvEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/events", {
      params: {
        query: {
          ...(clinician ? { clinician } : {}),
          ...(patient ? { patient } : {}),
          ...(visit ? { visit } : {}),
        },
      },
    });
    if (err) {
      setError("Could not load the EVV event ledger.");
      setLoading(false);
      return;
    }
    setEvents(((data ?? []) as EvvEventRow[]) ?? []);
    setLoading(false);
  }, [client, clinician, patient, visit]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="EVV Event Ledger" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          <EmptyState title="No events" description="No EVV capture events match your filters." />
        ) : (
          <DataTable<EvvEventRow>
            rows={events}
            rowKey={(e) => e.id}
            onSelect={(e) => navigate(`/evv/events/${e.id}`)}
            columns={[
              { header: "Captured", cell: (e) => ts(e.capturedAt) },
              { header: "Kind", cell: (e) => e.kind },
              { header: "Clinician", cell: (e) => e.postingMembershipId },
              { header: "Visit", cell: (e) => e.visitId },
              { header: "GPS quality", cell: (e) => <StatusChip value={e.gpsQuality} colorMap={EVV_QUALITY_COLOR} /> },
            ]}
          />
        )
      }
    />
  );
}
