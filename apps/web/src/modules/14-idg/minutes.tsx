import {
  EmptyState,
  Glyph,
  type GlyphName,
  InfoRows,
  LoadingSpinner,
  Panel,
  StatusPill,
  t,
  tint,
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
// 2026-09 "Lantern Clinical 2.0" pass: a status banner, a KPI strip of the three frozen counts (the mockup
// summary-strip pattern), and two flat Panels (sign-off record, immutability + amendment). Only fields
// `GET .../minutes` returns are drawn. NOT drawn, because no route returns them: the frozen attendee /
// decision / action-item lists themselves (deliberately narrative-free — see above), the amendment history (POST-only; no list route).
//
// The §7.8 amendment-request control is here now (the M5 §164.526 pattern). The SERVER owns the §2.2 D13
// finalize-on-adjournment, the immutability of `final` minutes (the M4 trigger refuses a content UPDATE),
// and the idg.amend_minutes permission (ADR-0030 — no frontend authz). Reads
// GET /api/v1/idg/meetings/:id/minutes via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import type { MinutesView } from "./idg-api";
import { AmendmentModal } from "./idg-meeting-modals";
import { IdgPageHead, IdgStat } from "./idg-page-kit";
import { MINUTES_TONE, stateLabel } from "./idg-status";

/**
 * The minutes read view plus the fields `GET .../minutes` gained with the signer-name / render-status pass
 * (`finalizedByName`, `finalizedByDiscipline`, `renderStatus`). Declared as an optional overlay so this screen
 * type-checks both before and after the typed client is regenerated from the contract; once regenerated the
 * generated fields simply satisfy the overlay.
 */
type MinutesScreenView = MinutesView & {
  finalizedByName?: string | null;
  finalizedByDiscipline?: string | null;
  renderStatus?: "not_rendered" | "pending" | "rendered";
};

const RENDER_STATUS_LABEL = {
  not_rendered: "Not rendered",
  pending: "Rendering — the document will appear here once M22 completes the render",
  rendered: "Rendered",
} as const;

export function Minutes(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [minutes, setMinutes] = useState<MinutesScreenView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 404 is not a failure: a minutes row does not exist until the meeting is adjourned (D13).
  const [notYet, setNotYet] = useState(false);
  const [amending, setAmending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setNotYet(false);
    const {
      data,
      error: err,
      response,
    } = await client.GET("/api/v1/idg/meetings/{id}/minutes", {
      params: { path: { id } },
    });
    if (err && response?.status === 404) {
      setNotYet(true);
      setLoading(false);
      return;
    }
    if (err) {
      setError("Could not load the minutes for this meeting.");
      setLoading(false);
      return;
    }
    setMinutes((data ?? null) as MinutesScreenView | null);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isFinal = minutes?.status === "final";

  const header = (
    <IdgPageHead
      title="IDG Minutes"
      subtitle="The finalized record of what the interdisciplinary group reviewed and decided."
      actions={
        minutes ? (
          <>
            <StatusPill
              label={stateLabel(minutes.status)}
              tone={MINUTES_TONE[minutes.status] ?? "neutral"}
            />
            {id ? (
              <Link to={`/idg/meetings/${id}`} className="wx-btn-secondary">
                Back to meeting
              </Link>
            ) : null}
            {isFinal ? (
              <button type="button" className="wx-btn-primary" onClick={() => setAmending(true)}>
                Request an amendment
              </button>
            ) : null}
          </>
        ) : undefined
      }
    />
  );

  if (error || (loading && minutes === null) || minutes === null) {
    return (
      <div className="wx-with-rail" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div className="wx-with-rail-main">
          {header}
          <div className="wx-list-state">
            {notYet ? (
              <>
                <EmptyState
                  title="No minutes yet"
                  description="Minutes are created when the meeting is adjourned. Until then, decisions and attendance are on the live meeting surface."
                />
                <Link to={`/idg/meetings/${id}`} className="wx-btn-secondary">
                  Back to meeting
                </Link>
              </>
            ) : error ? (
              <>
                <EmptyState title="Unavailable" description={error} />
                <button type="button" className="wx-btn-secondary" onClick={() => void load()}>
                  Retry
                </button>
              </>
            ) : loading ? (
              <LoadingSpinner />
            ) : (
              <EmptyState title="Not found" description="No minutes for this meeting." />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        {header}

        <output
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.625rem",
            padding: "0.75rem 1rem",
            borderRadius: t.radiusMd,
            background: tint(isFinal ? t.success : t.primary),
            color: isFinal ? t.success : t.primary,
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          <Glyph name={isFinal ? "lock" : "clock"} size={18} />
          <span>
            {isFinal
              ? "Final — this snapshot is immutable; changes are made by amendment request."
              : "In progress — minutes finalize and freeze on adjournment."}
          </span>
        </output>

        <div className="wx-stat-grid" aria-label="Minutes summary">
          <FrozenStat icon="users" label="Attendance" value={minutes.attendanceCount} />
          <FrozenStat icon="clipboard-check" label="Decisions" value={minutes.decisionCount} />
          <FrozenStat icon="check-circle" label="Action items" value={minutes.actionItemCount} />
          <IdgStat
            icon={isFinal ? "lock" : "clock"}
            label="Record"
            value={isFinal ? "Final" : "Draft"}
            hint={isFinal ? "Immutable" : "Finalizes on adjournment"}
            color={isFinal ? t.success : undefined}
          />
        </div>

        <Panel
          title="Sign-off record"
          icon="file-text"
          description="Attribution stamped by the server when the meeting adjourned."
        >
          <InfoRows
            rows={[
              { label: "Status", value: stateLabel(minutes.status) },
              {
                label: "Finalized",
                value: (
                  <span className="tabular-nums">
                    {isFinal && minutes.finalizedAt
                      ? minutes.finalizedAt.slice(0, 16).replace("T", " ")
                      : "Not finalized yet"}
                  </span>
                ),
              },
              {
                label: "Finalized by",
                value: !isFinal ? (
                  "—"
                ) : minutes.finalizedByName ? (
                  <span>
                    <span style={{ fontWeight: 600 }}>{minutes.finalizedByName}</span>
                    {minutes.finalizedByDiscipline ? (
                      <span className="wx-row-sub">
                        {" "}
                        · {minutes.finalizedByDiscipline.replace(/_/g, " ")}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="wx-data-md">{minutes.finalizedByMembershipId ?? "—"}</span>
                ),
              },
              {
                label: "Rendered document",
                value: minutes.minutesDocumentId ? (
                  <span>
                    {RENDER_STATUS_LABEL.rendered} ·{" "}
                    <span className="wx-data-md">{minutes.minutesDocumentId}</span>
                  </span>
                ) : (
                  <span>
                    {
                      RENDER_STATUS_LABEL[
                        minutes.renderStatus ?? (isFinal ? "pending" : "not_rendered")
                      ]
                    }
                  </span>
                ),
              },
              { label: "Minutes", value: <span className="wx-data-md">{minutes.id}</span> },
              {
                label: "Meeting",
                value: <span className="wx-data-md">{minutes.meetingId}</span>,
              },
            ]}
          />
        </Panel>

        <Panel title="Immutability and amendments" icon="lock">
          <p style={{ margin: 0, fontSize: "0.875rem", color: t.onSurface }}>
            {isFinal
              ? "Final minutes are never edited in place. To correct the record, file an amendment request; it is reviewed and tracked separately from this snapshot."
              : "Amendment requests open once the minutes are final."}
          </p>
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.75rem", color: t.onSurfaceVariant }}>
            The frozen attendance, decision and action-item lists are summarised as counts here:
            they carry the §2.6 decision narrative, which this surface deliberately does not
            publish. The readable minutes are the rendered document.
          </p>
          {notice ? (
            <output
              style={{
                display: "block",
                marginTop: "0.75rem",
                fontSize: "0.8125rem",
                color: t.success,
              }}
            >
              {notice}
            </output>
          ) : null}
        </Panel>

        <AmendmentModal
          open={amending}
          minutesId={minutes.id}
          onClose={() => setAmending(false)}
          onSubmitted={(r) =>
            setNotice(`Amendment request ${r.amendmentId.slice(0, 8)} filed against these minutes.`)
          }
        />
      </div>

      <aside className="wx-with-rail-side" aria-label="Minutes context">
        <Panel title="Meeting" icon="calendar-check">
          <dl className="wx-kv" style={{ gridTemplateColumns: "5.5rem minmax(0, 1fr)" }}>
            <dt>Status</dt>
            <dd>
              <StatusPill
                label={stateLabel(minutes.status)}
                tone={MINUTES_TONE[minutes.status] ?? "neutral"}
              />
            </dd>
            <dt>Record</dt>
            <dd>{isFinal ? "Frozen at adjournment" : "Open until adjournment"}</dd>
            <dt>Snapshot</dt>
            <dd>
              {minutes.attendanceCount === null &&
              minutes.decisionCount === null &&
              minutes.actionItemCount === null
                ? "Counts pending"
                : "Counts frozen"}
            </dd>
          </dl>
        </Panel>

        <Panel title="Quick actions" icon="zap">
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {id ? (
              <Link
                to={`/idg/meetings/${id}`}
                className="wx-btn-secondary"
                style={{ justifyContent: "flex-start" }}
              >
                <Glyph name="calendar-check" size={16} /> Open meeting
              </Link>
            ) : null}
            <Link
              to="/idg/schedule"
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="calendar" size={16} /> IDG schedule
            </Link>
            <Link
              to="/idg/action-items"
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="clipboard-check" size={16} /> My action items
            </Link>
          </div>
        </Panel>

        <Panel title="Next steps" icon="info">
          <p className="wx-row-sub" style={{ margin: 0 }}>
            {isFinal
              ? "Review the rendered document, then file an amendment request if the record needs correcting."
              : "Adjourn the meeting from its live surface to finalize and freeze these minutes."}
          </p>
        </Panel>
      </aside>
    </div>
  );
}

/** One frozen-snapshot count. `null` means "adjournment has not frozen it", which is not zero. */
function FrozenStat({
  icon,
  label,
  value,
}: {
  icon: GlyphName;
  label: string;
  value: number | null;
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color: t.primary, background: tint(t.primary) }}
      >
        <Glyph name={icon} size={24} strokeWidth={1.6} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wx-stat-label">{label}</div>
        <strong className="wx-stat-value wx-nums">{value ?? "—"}</strong>
        <div className="wx-stat-label">
          {value === null ? "not frozen yet" : "frozen at adjournment"}
        </div>
      </div>
    </div>
  );
}
