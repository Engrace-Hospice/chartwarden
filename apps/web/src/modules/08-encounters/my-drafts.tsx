import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — My Drafts (M8 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The author's open encounter drafts: one row per in-flight draft with its type · discipline · service
// date · late-entry tier. Reconciled to Lantern (R1): the §2.5 late-entry tier is a §6.6 StatusPill
// (normal calm, escalating tiers warn/alert), ids mono, table No-Line. A row opens the Encounter Read
// view. Reads GET /api/v1/encounters/my-drafts via the typed client; the server scopes to the calling
// author (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { lateEntryTone, stateLabel } from "./encounter-status";

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

  // §2.5 D4 tiers are normal | late_entry | significant_late_entry | administrative_override —
  // anything but `normal` is a late entry. (Was compared to a non-existent "on_time" tier.)
  const lateCount = items.filter((e) => e.lateEntryTier !== "normal").length;

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
            <table>
              <thead>
                <tr>
                  <th>Encounter</th>
                  <th>Discipline</th>
                  <th>Service date</th>
                  <th>Late-entry</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr
                    key={e.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/patients/${e.patientId}/encounters/${e.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/patients/${e.patientId}/encounters/${e.id}`);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{e.encounterType}</td>
                    <td>{stateLabel(e.discipline)}</td>
                    <td className="tabular-nums">{e.serviceDate}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(e.lateEntryTier)}
                        tone={lateEntryTone(e.lateEntryTier)}
                      />
                    </td>
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
