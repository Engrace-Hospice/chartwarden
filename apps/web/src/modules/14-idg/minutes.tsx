// apps/web/src/modules/14-idg — Minutes (per meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace" (minutes
// reading surface). The finalized (or in-progress) minutes view for a meeting. The full attendance /
// decision-list / action-item-list snapshot rendering and the IDG-Coordinator amendment-request control (§7.8,
// M5 §164.526 pattern) fill in as their read/write paths harden; the SERVER owns the §2.2 D13 finalize-on-
// adjournment, the immutability of `final` minutes (the M4 trigger refuses content UPDATE), and the
// idg.amend_minutes permission (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/meetings/:id/minutes via
// the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface MinutesView {
  id: string;
  meetingId: string;
  status: string;
}

export function Minutes(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [minutes, setMinutes] = useState<MinutesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/idg/meetings/{id}/minutes", {
      params: { path: { id } },
    });
    if (err) {
      setError("Could not load the minutes for this meeting.");
      setLoading(false);
      return;
    }
    setMinutes((data ?? null) as MinutesView | null);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isFinal = minutes?.status === "final";

  return (
    <DetailPageLayout header={<PageHeader title="IDG Minutes" breadcrumb={minutes?.status} />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && minutes === null ? (
        <LoadingSpinner />
      ) : minutes === null ? (
        <EmptyState title="Not found" description="No minutes for this meeting." />
      ) : (
        <section style={{ maxWidth: "40rem" }}>
          <p style={{ fontSize: "0.9rem", color: isFinal ? "#15803d" : "#b45309", fontWeight: 600 }}>
            {isFinal
              ? "Finalized — these minutes are immutable; amendments are tracked separately."
              : "In progress — minutes finalize on adjournment."}
          </p>
          <dl style={{ margin: 0, fontSize: "0.9rem" }}>
            <dt style={dt}>Minutes</dt>
            <dd style={dd}>{minutes.id}</dd>
            <dt style={dt}>Meeting</dt>
            <dd style={dd}>{minutes.meetingId}</dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>{minutes.status}</dd>
          </dl>
        </section>
      )}
    </DetailPageLayout>
  );
}

const dt = { color: "#6b7280", marginTop: "0.75rem" } as const;
const dd = { margin: "0.1rem 0 0", fontWeight: 600, wordBreak: "break-all" } as const;
