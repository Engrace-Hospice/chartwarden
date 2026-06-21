// apps/web/src/modules/08-encounters — My Drafts (M8 §5.1, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The author's open encounter drafts: one row per in-flight draft with its type · discipline · service
// date · late-entry tier. A row opens the Encounter Read view (the authoring surface §5.2 fills in as
// its write path hardens). Reads GET /api/v1/encounters/my-drafts via the typed client; the server
// scopes to the calling author (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";

interface EncounterRow {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
}

export function MyDrafts(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<EncounterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/encounters/my-drafts");
      if (!active) return;
      if (err) {
        setError("Could not load your drafts.");
        setLoading(false);
        return;
      }
      setItems((data?.encounters ?? []) as EncounterRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const lateCount = items.filter((e) => e.lateEntryTier !== "on_time").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="My drafts" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Open drafts" value={items.length} />
          <KpiCard label="Late-entry" value={lateCount} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState title="No drafts" description="You have no open encounter drafts." />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={th}>Encounter</th>
                  <th style={th}>Discipline</th>
                  <th style={th}>Service date</th>
                  <th style={th}>Late-entry</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => navigate(`/patients/${e.patientId}/encounters/${e.id}`)}
                    style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                  >
                    <td style={td}>{e.encounterType}</td>
                    <td style={td}>{e.discipline}</td>
                    <td style={td}>{e.serviceDate}</td>
                    <td style={td}>{e.lateEntryTier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
