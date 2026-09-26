import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — Minutes (per meeting) (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace" (minutes
// reading surface). The finalized (or in-progress) minutes view for a meeting.
//
// #91 / F-062 — this screen used to render two uuids and a status pill, for the document that IS the
// evidence of the 42 CFR 418.56(d) review. That was not a UI shortcut: `GET .../minutes` projected 3 of
// `idg_minutes`' 13 columns, and adjournment — which stamps `status: final` — wrote NONE of the three
// snapshot columns whose whole purpose is to freeze the record. So the finalized minutes of every meeting
// the platform ever adjourned said a review happened and nothing about what it reviewed. Both halves are
// fixed; this screen now shows the finalize attribution and what was frozen.
//
// THE SNAPSHOTS ARE SHOWN AS COUNTS, not contents. They nest the §2.6 decision payloads — the §3.3
// denylisted clinical narrative — and this module's read surface is narrative-free by construction, so the
// readable document is the M22 render (`minutesDocumentId`), which carries its own consent gate. A count
// is not a substitute for that render; it is the honest answer to "is there anything in these minutes",
// which a blank screen could not give.
//
// The §7.8 amendment-request control is here now (the M5 §164.526 pattern). The SERVER owns the §2.2 D13
// finalize-on-adjournment, the immutability of `final` minutes (the M4 trigger refuses a content UPDATE),
// and the idg.amend_minutes permission (ADR-0030 — no frontend authz). Reads
// GET /api/v1/idg/meetings/:id/minutes via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import type { MinutesView } from "./idg-api";
import { AmendmentModal } from "./idg-meeting-modals";
import { MINUTES_TONE, stateLabel } from "./idg-status";

export function Minutes(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [minutes, setMinutes] = useState<MinutesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amending, setAmending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    <DetailPageLayout
      header={
        <PageHeader
          title="IDG Minutes"
          actions={
            minutes ? (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <StatusPill
                  label={stateLabel(minutes.status)}
                  tone={MINUTES_TONE[minutes.status] ?? "neutral"}
                />
                {minutes.status === "final" ? (
                  <Button tone="tertiary" onClick={() => setAmending(true)}>
                    Request an amendment
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        />
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && minutes === null ? (
        <LoadingSpinner />
      ) : minutes === null ? (
        <EmptyState title="Not found" description="No minutes for this meeting." />
      ) : (
        <section style={{ maxWidth: "40rem" }}>
          <p
            style={{
              fontSize: "0.9rem",
              color: isFinal ? "var(--color-success)" : "var(--color-warning)",
              fontWeight: 600,
            }}
          >
            {isFinal
              ? "Finalized — these minutes are immutable; amendments are tracked separately."
              : "In progress — minutes finalize on adjournment."}
          </p>
          <dl style={{ margin: 0, fontSize: "0.9rem" }}>
            <dt style={dt}>Minutes</dt>
            <dd style={dd} className="wx-data-md">
              {minutes.id}
            </dd>
            <dt style={dt}>Meeting</dt>
            <dd style={dd} className="wx-data-md">
              {minutes.meetingId}
            </dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>
              <StatusPill
                label={stateLabel(minutes.status)}
                tone={MINUTES_TONE[minutes.status] ?? "neutral"}
              />
            </dd>
            {isFinal ? (
              <>
                <dt style={dt}>Finalized</dt>
                <dd style={dd} className="tabular-nums">
                  {minutes.finalizedAt ? minutes.finalizedAt.slice(0, 16).replace("T", " ") : "—"}
                </dd>
                <dt style={dt}>Finalized by</dt>
                <dd style={dd} className="wx-data-md">
                  {minutes.finalizedByMembershipId ?? "—"}
                </dd>
              </>
            ) : null}
            <dt style={dt}>Attendance</dt>
            <dd style={dd} className="tabular-nums">
              {minutes.attendanceCount ?? "not frozen yet"}
            </dd>
            <dt style={dt}>Decisions</dt>
            <dd style={dd} className="tabular-nums">
              {minutes.decisionCount ?? "not frozen yet"}
            </dd>
            <dt style={dt}>Action items</dt>
            <dd style={dd} className="tabular-nums">
              {minutes.actionItemCount ?? "not frozen yet"}
            </dd>
            <dt style={dt}>Rendered document</dt>
            <dd style={dd} className="wx-data-md">
              {minutes.minutesDocumentId ?? "not rendered"}
            </dd>
          </dl>
          <p style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
            The frozen attendance, decision and action-item lists are summarised as counts here:
            they carry the §2.6 decision narrative, which this surface deliberately does not
            publish. The readable minutes are the rendered document.
          </p>
          {notice ? (
            <output style={{ display: "block", fontSize: "0.8rem", marginTop: "0.5rem" }}>
              {notice}
            </output>
          ) : null}
          <AmendmentModal
            open={amending}
            minutesId={minutes.id}
            onClose={() => setAmending(false)}
            onSubmitted={(r) =>
              setNotice(
                `Amendment request ${r.amendmentId.slice(0, 8)} filed against these minutes.`,
              )
            }
          />
        </section>
      )}
    </DetailPageLayout>
  );
}

const dt = { color: "var(--color-on-surface-variant)", marginTop: "0.75rem" } as const;
const dd = { margin: "0.1rem 0 0", fontWeight: 600, wordBreak: "break-all" } as const;
