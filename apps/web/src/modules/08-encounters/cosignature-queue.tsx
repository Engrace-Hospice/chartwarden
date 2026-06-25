import {
  CountdownChip,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — Cosignature Queue (M8 §5.5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The RN / Clinical Supervisor cosignature work queue: one row per encounter awaiting cosignature.
// Reconciled to Lantern (R1): the §5.5 SLA is a §7.5 CountdownChip counting down to the 48h hard cap
// (warning → alert → overdue), status is a §6.6 StatusPill, ids are mono, the table is No-Line. Reads
// GET /api/v1/encounters/cosignature-queue via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { ENCOUNTER_TONE, cosignDueAt, cosignOverdue, stateLabel } from "./encounter-status";

interface EncounterRow {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  signedAt: string | null;
}

export function CosignatureQueue(): JSX.Element {
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
      const { data, error: err } = await client.GET("/api/v1/encounters/cosignature-queue");
      if (!active) return;
      if (err) {
        setError("Could not load the cosignature queue.");
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

  const overdue = items.filter((e) => cosignOverdue(e.signedAt)).length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Cosignatures" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Pending" value={items.length} />
          <KpiCard label="Past hard cap" value={overdue} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No cosignatures"
            description="No encounters are awaiting your cosignature."
          />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Encounter</th>
                  <th>Discipline</th>
                  <th>Service date</th>
                  <th>Cosign SLA</th>
                  <th>Status</th>
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
                      {e.signedAt ? (
                        <CountdownChip
                          dueAt={cosignDueAt(e.signedAt)}
                          warnWithinHours={36}
                          alertWithinHours={24}
                          label="Cosign"
                        />
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>—</span>
                      )}
                    </td>
                    <td>
                      <StatusPill
                        label={stateLabel(e.status)}
                        tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
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
