// apps/web/src/modules/14-idg — Per-Patient Packet (read-only chart embed) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace" (packet
// reading surface). A read-only view of one patient's IDG packet digest within a meeting (freeze state +
// identifiers). The full per-discipline `built_snapshot` viewer with the discipline-switcher tabs fills in as
// the packet-content read path hardens; the SERVER owns the §7.2/W-SUD-01 SUD redaction (blocks elided at the
// SQL-filter level before data leaves the DB, response carries `appliedSudRedaction`) and the §4.7
// idg_meeting_scope + caseload_or_scope ABAC (ADR-0030 — no frontend authz; out-of-scope packets 404). Reads
// GET /api/v1/idg/meetings/:meetingId/packets/:patientId via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface PacketView {
  packetId: string;
  meetingId: string;
  patientId: string;
  frozenAt: string | null;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function PatientPacket(): JSX.Element {
  const client = useApiClient();
  const { meetingId, patientId } = useParams<{ meetingId: string; patientId: string }>();
  const [packet, setPacket] = useState<PacketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!meetingId || !patientId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET(
      "/api/v1/idg/meetings/{meetingId}/packets/{patientId}",
      { params: { path: { meetingId, patientId } } },
    );
    if (err) {
      setError("Could not load this patient's IDG packet.");
      setLoading(false);
      return;
    }
    setPacket((data ?? null) as PacketView | null);
    setLoading(false);
  }, [client, meetingId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PatientWorkspaceLayout banner={<PageHeader title="IDG Packet" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && packet === null ? (
        <LoadingSpinner />
      ) : packet === null ? (
        <EmptyState title="Not found" description="No IDG packet for this patient in this meeting." />
      ) : (
        <section style={{ padding: "1.5rem", maxWidth: "32rem" }}>
          <dl style={{ margin: 0, fontSize: "0.9rem" }}>
            <dt style={dt}>Packet</dt>
            <dd style={dd}>{packet.packetId}</dd>
            <dt style={dt}>Meeting</dt>
            <dd style={dd}>{packet.meetingId}</dd>
            <dt style={dt}>Patient</dt>
            <dd style={dd}>{packet.patientId}</dd>
            <dt style={dt}>State</dt>
            <dd style={{ ...dd, color: packet.frozenAt ? "#6b7280" : "#b45309" }}>
              {packet.frozenAt ? `frozen ${ts(packet.frozenAt)}` : "draft (pre-adjournment)"}
            </dd>
          </dl>
        </section>
      )}
    </PatientWorkspaceLayout>
  );
}

const dt = { color: "#6b7280", marginTop: "0.75rem" } as const;
const dd = { margin: "0.1rem 0 0", fontWeight: 600, wordBreak: "break-all" } as const;
