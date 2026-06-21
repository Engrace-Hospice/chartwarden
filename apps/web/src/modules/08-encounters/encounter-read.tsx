// apps/web/src/modules/08-encounters — Encounter Read (M8 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Patient Workspace + Documentation Workspace."
// The signed encounter (or in-flight draft): the encounter header (type · discipline · service date ·
// status · late-entry tier) | the lifecycle/version meta | a right aside with the cosignature-request
// state. SUD-flagged content the caller may not see is omitted SERVER-side (§7.6) — never a frontend
// hide. Reads GET /api/v1/encounters/:encounterId (+ /cosignature) via the typed client; the server
// enforces every scope (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface Encounter {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
  version: number;
  isF2f: boolean;
  signedAt: string | null;
  cosignedAt: string | null;
}

export function EncounterRead(): JSX.Element {
  const client = useApiClient();
  const { encounterId } = useParams<{ encounterId: string }>();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [cosignStatus, setCosignStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!encounterId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/encounters/{encounterId}", {
        params: { path: { encounterId } },
      });
      if (!active) return;
      if (err || !data?.id) {
        setError("Could not load the encounter.");
        setLoading(false);
        return;
      }
      setEncounter({
        id: data.id,
        patientId: data.patientId,
        encounterType: data.encounterType,
        discipline: data.discipline,
        serviceDate: data.serviceDate,
        status: data.status,
        lateEntryTier: data.lateEntryTier,
        version: data.version,
        isF2f: data.isF2f,
        signedAt: data.signedAt ?? null,
        cosignedAt: data.cosignedAt ?? null,
      });
      // Cosignature state is best-effort context for the aside; a 404 just means "no request".
      const { data: cos } = await client.GET("/api/v1/encounters/{encounterId}/cosignature", {
        params: { path: { encounterId } },
      });
      if (active) setCosignStatus(cos?.status ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, encounterId]);

  if (loading) return <LoadingSpinner />;
  if (error || !encounter) return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader title={`Encounter — ${encounter.encounterType}`}>
          <span style={meta}>
            {encounter.discipline} · {encounter.serviceDate} · {encounter.status}
            {encounter.isF2f ? " · F2F" : ""}
          </span>
        </PageHeader>
      }
      aside={
        <aside style={{ width: "18rem", flexShrink: 0, borderLeft: "1px solid #e5e7eb", padding: "1.5rem", overflow: "auto" }}>
          <h3 style={h3}>Cosignature</h3>
          {cosignStatus ? (
            <p style={meta}>Status: {cosignStatus}</p>
          ) : (
            <p style={meta}>No cosignature request for this encounter.</p>
          )}
          <h3 style={{ ...h3, marginTop: "1rem" }}>Lifecycle</h3>
          <ul style={{ paddingLeft: "1rem", margin: "0.5rem 0", fontSize: "0.8rem" }}>
            <li>Status: {encounter.status}</li>
            <li>Version: v{encounter.version}</li>
            <li>Late-entry tier: {encounter.lateEntryTier}</li>
            {encounter.signedAt ? <li>Signed: {encounter.signedAt.slice(0, 16).replace("T", " ")}</li> : null}
            {encounter.cosignedAt ? <li>Cosigned: {encounter.cosignedAt.slice(0, 16).replace("T", " ")}</li> : null}
          </ul>
        </aside>
      }
    >
      <div style={card}>
        <h3 style={h3}>Encounter details</h3>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem", fontSize: "0.85rem" }}>
          <dt style={dt}>Type</dt>
          <dd style={dd}>{encounter.encounterType}</dd>
          <dt style={dt}>Discipline</dt>
          <dd style={dd}>{encounter.discipline}</dd>
          <dt style={dt}>Service date</dt>
          <dd style={dd}>{encounter.serviceDate}</dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>{encounter.status}</dd>
        </dl>
        <p style={{ ...meta, marginTop: "1rem" }}>
          The authoring, finalize/Layer-2, and signing surfaces (§5.2–5.4) fill in as their write
          surfaces harden; this read view renders the server-assembled, SUD-redacted encounter.
        </p>
      </div>
    </DetailPageLayout>
  );
}

const h3 = { fontSize: "0.8rem", textTransform: "uppercase", color: "#6b7280", margin: "0 0 0.5rem" } as const;
const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
const card = { border: "1px solid #f3f4f6", borderRadius: "0.375rem", padding: "1rem" } as const;
const dt = { fontWeight: 600, color: "#6b7280" } as const;
const dd = { margin: 0 } as const;
